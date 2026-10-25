#!/usr/bin/env python3
"""remote-alert-telegram.py — avisos del productor remoto de MainSpot por Telegram, con acuse humano.

DEC-0064 / DEC-0065: bot de Telegram exclusivo de los avisos del productor, con chat privado;
token, chat, usuario autorizado y clave de acuse viven solo en el equipo de MainSpot.
Canon técnico F-01 (0.2.0-staging): API-0005 … API-0008, ADR-0001 … ADR-0004.

Modos:
  (sin argumentos)    lo invoca `db-backup-remote.py` (sin shell, entorno PATH/HOME) con un evento
                      JSON por stdin; envía un mensaje de texto plano por HTTPS, valida el recibo de
                      Telegram, lo persiste en el registro local e imprime una línea JSON `{"receipt": …}`.
  --synthetic-test    igual, con un evento TEST-SYNTHETIC (prueba de recepción real, DEC-0065).
  --ack-poll [--max-seconds N]
                      único consumidor `getUpdates` de los callbacks «Confirmar recepción».
  --check-overdue     vencimientos, recordatorios acotados y atención del operador.
  --status            estado del registro en JSON, sin secretos.

Configuración (archivos regulares del usuario, 0600, en un directorio no escribible por otros):
  $HOME/.config/mainspot/backup/telegram-alert.env
    TELEGRAM_BOT_TOKEN=…              bot exclusivo de este productor
    TELEGRAM_CHAT_ID=…                chat privado del propietario
    TELEGRAM_ACK_USER_ID=…            opcional; por defecto el chat si es privado (positivo)
    ACK_DEADLINE_SECONDS=…            60…604800  ┐
    ACK_REMINDER_INTERVAL_SECONDS=…   60…604800  ├ política de acuse (las tres o ninguna)
    ACK_MAX_REMINDERS=…               0…10       ┘
    ALERT_STATE_DIR=…                 opcional; por defecto $HOME/.local/state/mainspot/alerts
    TELEGRAM_API_BASE=https://…       opcional; siempre https://
    TELEGRAM_CA_FILE=…                opcional; solo laboratorio
  $HOME/.config/mainspot/backup/telegram-ack.key
    clave de acuse: 64…128 caracteres hex (≥ 32 bytes aleatorios); no es el token.
  Sin clave o sin política, los avisos se envían sin botón y el evento queda
  `needs_operator_attention` (prioridad de entrega, DEC-0065).

Códigos de salida (el productor los traduce a `delivery=`):
  0  aceptado por la API con recibo válido y persistido (o ya aceptado: no se reenvía)
  10 sin configurar
  11 configuración o estado inseguro o inválido, o credenciales rechazadas (400/401/403/404)
  12 evento o uso inválido
  13 Telegram no disponible sin aceptación (reintentable)
  14 mal dirigido: Telegram creó el mensaje en otro chat (no se reintenta)
  15 aceptación incierta: pudo crearse el mensaje sin recibo válido (no se reintenta)
  16 aceptado sin recibo persistido (no se reintenta)
  17 consumidor concurrente, webhook configurado o conflicto 409
  18 hay avisos que requieren atención (--check-overdue / --status)

`api_accepted` nunca equivale a `human_acknowledged`: solo un callback auténtico del usuario
autorizado lo produce. Nunca imprime el token, el chat, el usuario ni la URL de la API.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import contextlib
import fcntl
import hashlib
import hmac
import http.client
import json
import os
import re
import ssl
import stat
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_REL = Path(".config") / "mainspot" / "backup" / "telegram-alert.env"
ACK_KEY_NAME = "telegram-ack.key"
STATE_REL = Path(".local") / "state" / "mainspot" / "alerts"
CONNECT_READ_TIMEOUT_S = 8
MAX_ATTEMPTS = 2           # intento acotado en la misma ejecución (DEC-0065)
RETRY_SLEEP_S = 2
MAX_RETRY_AFTER_S = 5      # un 429 con espera mayor se trata como «no disponible»
MAX_EVENT_BYTES = 4096
MAX_RESPONSE_BYTES = 65536
MAX_UPDATES_BYTES = 1 << 20
POLL_TIMEOUT_S = 25
MAX_POLL_SECONDS = 3600
MAX_REMINDERS_PER_RUN = 5
LOCK_TIMEOUT_S = 10
DATE_MIN = 1_600_000_000
DATE_FUTURE_SLACK_S = 300
DATE_PAST_WINDOW_S = 86_400
SCHEMA = "mainspot-alert-ack/v1"
ACK_DOMAIN = b"mainspot-alert-ack|v1|"
ACTOR_DOMAIN = b"mainspot-alert-ack|actor|"
ACK_BUTTON = "Confirmar recepción"

ALLOWED_CODES = {
    # §8.2 paso 0 y §10.1 (contrato 1.2.0)
    "E-SIZE-LIMIT", "SIZE-OVER-80PCT",
    # §13 con «Aviso: sí» que el productor emite
    "E-TLS", "E-AUTH-SKEW", "E-AUTH-SIGNATURE", "E-AUTH-DENIED", "E-BUCKET", "E-NOT-IMPLEMENTED",
    "E-REQUEST", "E-UPLOAD-WINDOW", "E-INTEGRITY-UPLOAD", "E-INTEGRITY-VERIFY", "E-LOCAL-INTEGRITY",
    "E-REMOTE-CONFLICT", "E-FRESHNESS", "E-RETENTION-VIOLATION", "E-RESTORE-MAC",
    # prueba sintética de entrega (DEC-0065)
    "TEST-SYNTHETIC",
}
ACK_CODES_ALWAYS = {"TEST-SYNTHETIC"}
SEVERITIES = {"error", "warning", "info"}
INT_FIELDS = {"size_bytes", "manifest_bytes", "total_bytes", "limit_bytes"}
FIELD_RE = {
    "ts": re.compile(r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z"),
    "producer": re.compile(r"\Adb-backup-remote\Z"),
    "event_id": re.compile(r"\A[0-9a-f]{32}\Z"),
    "backup_id": re.compile(r"\Amainspot-db-[0-9]{8}T[0-9]{6}Z\Z"),
    "action": re.compile(r"\A[a-z0-9-]{1,64}\Z"),
    "scope": re.compile(r"\A[a-z0-9-]{1,32}\Z"),
}
REQUIRED = {"ts", "producer", "event_id", "code", "severity"}
TOKEN_RE = re.compile(r"\A[0-9]{5,16}:[A-Za-z0-9_-]{30,64}\Z")
CHAT_RE = re.compile(r"\A-?[0-9]{1,20}\Z")
USER_RE = re.compile(r"\A[0-9]{1,20}\Z")
KEY_RE = re.compile(r"\A[0-9a-f]{64,128}\Z")
EVENT_ID_RE = FIELD_RE["event_id"]
CALLBACK_RE = re.compile(r"\Aa1:([0-9a-f]{32}):([0-9a-f]{24})\Z")
RECORD_RE = re.compile(r"\A[0-9a-f]{32}\.json\Z")
LAB_NOW_RE = re.compile(r"\A[0-9]{9,11}\Z")
POLICY_BOUNDS = {
    "ACK_DEADLINE_SECONDS": (60, 604_800),
    "ACK_REMINDER_INTERVAL_SECONDS": (60, 604_800),
    "ACK_MAX_REMINDERS": (0, 10),
}

# Máquina de estados (API-0007). Cualquier otra transición es un error de programa.
TRANSITIONS: dict[str, set[str]] = {
    "created": {"api_accepted", "send_failed", "api_acceptance_uncertain", "misrouted"},
    "send_failed": {"api_accepted", "send_failed", "api_acceptance_uncertain", "misrouted"},
    "api_accepted": {"human_acknowledged", "ack_overdue", "needs_operator_attention"},
    "api_acceptance_uncertain": {"human_acknowledged", "ack_overdue"},
    "ack_overdue": {"acknowledged_late", "needs_operator_attention"},
    "needs_operator_attention": {"acknowledged_late"},
    "misrouted": set(),
    "human_acknowledged": set(),
    "acknowledged_late": set(),
}
ACKED = {"human_acknowledged", "acknowledged_late"}
ACCEPTED = {"api_accepted", "ack_overdue", "needs_operator_attention"} | ACKED
ACKABLE = {"api_accepted", "api_acceptance_uncertain", "ack_overdue", "needs_operator_attention"}
ATTENTION = {"ack_overdue", "needs_operator_attention", "send_failed", "api_acceptance_uncertain", "misrouted"}


class Exit(Exception):
    def __init__(self, code: int, reason: str):
        super().__init__(reason)
        self.code, self.reason = code, reason


class Busy(Exception):
    """Otro proceso tiene el candado de consumidor único."""


class Corrupt(Exception):
    """Registro de evento ilegible o inconsistente."""


def is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def now() -> float:
    """Reloj UTC; MAINSPOT_ALERT_LAB_NOW solo existe para pruebas (el productor no la propaga)."""
    lab = os.environ.get("MAINSPOT_ALERT_LAB_NOW", "")
    if lab:
        if not LAB_NOW_RE.match(lab):
            raise Exit(12, "lab-clock-invalid")
        return float(lab)
    return time.time()


def iso(ts: float | int | None) -> str | None:
    return None if ts is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


# ---------------------------------------------------------------------------------------------
# Evento y configuración
# ---------------------------------------------------------------------------------------------

def validate_event(raw: bytes) -> dict:
    if len(raw) > MAX_EVENT_BYTES:
        raise Exit(12, "event-too-large")
    try:
        ev = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Exit(12, "event-not-json")
    if not isinstance(ev, dict) or not REQUIRED <= set(ev):
        raise Exit(12, "event-missing-fields")
    allowed = REQUIRED | set(FIELD_RE) | INT_FIELDS
    if set(ev) - allowed:
        raise Exit(12, "event-unknown-fields")
    if ev["code"] not in ALLOWED_CODES or ev["severity"] not in SEVERITIES:
        raise Exit(12, "event-code-or-severity")
    for k, v in ev.items():
        if k in INT_FIELDS:
            if not is_int(v) or not 0 <= v < 1 << 50:
                raise Exit(12, "event-bad-integer")
        elif k in FIELD_RE:
            if not isinstance(v, str) or not FIELD_RE[k].match(v):
                raise Exit(12, "event-bad-field")
    return ev


def requires_ack(ev: dict) -> bool:
    return ev["severity"] == "error" or ev["code"] in ACK_CODES_ALWAYS


def private_file(path: Path) -> None:
    """Archivo regular del usuario, sin bits de grupo/otros, en un directorio no escribible por otros."""
    try:
        st = path.lstat()
        parent = path.parent.stat()
    except FileNotFoundError:
        raise Exit(10, "not-configured")
    except OSError:
        raise Exit(11, "config-unreadable")
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Exit(11, "config-insecure")
    if parent.st_uid not in (0, os.getuid()) or parent.st_mode & 0o022:
        raise Exit(11, "config-dir-insecure")


def load_config(home: Path) -> dict:
    path = home / CONFIG_REL
    private_file(path)
    values: dict = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    if not TOKEN_RE.match(values.get("TELEGRAM_BOT_TOKEN", "")) or not CHAT_RE.match(values.get("TELEGRAM_CHAT_ID", "")):
        raise Exit(11, "config-invalid-credentials-format")
    base = values.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    if not base.startswith("https://"):
        raise Exit(11, "config-api-base-not-https")
    values["TELEGRAM_API_BASE"] = base
    ca = values.get("TELEGRAM_CA_FILE")
    if ca and not Path(ca).is_file():
        raise Exit(11, "config-ca-file-missing")
    if "TELEGRAM_ACK_USER_ID" in values and not USER_RE.match(values["TELEGRAM_ACK_USER_ID"]):
        raise Exit(11, "config-ack-user-invalid")
    state_dir = values.get("ALERT_STATE_DIR")
    if state_dir is not None and (not state_dir.startswith("/") or ".." in Path(state_dir).parts):
        raise Exit(11, "config-state-dir-invalid")
    present = [k for k in POLICY_BOUNDS if k in values]
    policy: dict | None = None
    if present:
        if len(present) != len(POLICY_BOUNDS):
            raise Exit(11, "config-ack-policy-incomplete")
        policy = {}
        for k, (lo, hi) in POLICY_BOUNDS.items():
            if not re.fullmatch(r"[0-9]{1,7}", values[k]) or not lo <= int(values[k]) <= hi:
                raise Exit(11, "config-ack-policy-invalid")
            policy[k] = int(values[k])
    values["_policy"] = policy
    values["_chat"] = int(values["TELEGRAM_CHAT_ID"])
    user = values.get("TELEGRAM_ACK_USER_ID")
    values["_user"] = int(user) if user else (values["_chat"] if values["_chat"] > 0 else None)
    return values


def ack_setup(cfg: dict, home: Path) -> tuple[bytes | None, str | None]:
    """Clave de acuse (≠ token) y política. Ausentes → sin botón; inseguras o inválidas → 11."""
    key_path = (home / CONFIG_REL).parent / ACK_KEY_NAME
    if not os.path.lexists(key_path):
        return None, "ack_key_missing"
    private_file(key_path)
    try:
        content = key_path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        raise Exit(11, "ack-key-unreadable")
    if not KEY_RE.match(content):
        raise Exit(11, "ack-key-invalid")
    if cfg["_policy"] is None:
        return None, "ack_policy_missing"
    if cfg["_user"] is None:
        return None, "ack_user_undetermined"
    return bytes.fromhex(content), None


def ack_tag(key: bytes, event_id: str) -> str:
    return hmac.new(key, ACK_DOMAIN + event_id.encode("ascii"), hashlib.sha256).hexdigest()[:24]


def callback_data(key: bytes, event_id: str) -> str:
    data = f"a1:{event_id}:{ack_tag(key, event_id)}"
    assert len(data.encode("ascii")) <= 64
    return data


def actor_ref(key: bytes, user_id: int) -> str:
    return hmac.new(key, ACTOR_DOMAIN + str(user_id).encode("ascii"), hashlib.sha256).hexdigest()[:16]


def ack_markup(key: bytes, event_id: str) -> dict:
    return {"inline_keyboard": [[{"text": ACK_BUTTON, "callback_data": callback_data(key, event_id)}]]}


def render(ev: dict, *, ack: bool, reminder: tuple[int, int] | None = None) -> str:
    sev = {"error": "ERROR", "warning": "AVISO", "info": "INFO"}[ev["severity"]]
    lines = [f"ID: {ev['event_id']}"]
    if reminder:
        lines.append(f"RECORDATORIO {reminder[0]}/{reminder[1]} · aviso sin acuse de recepción")
    lines += [f"MainSpot · respaldos remotos · {sev}", f"Código: {ev['code']}"]
    if "backup_id" in ev:
        lines.append(f"Respaldo: {ev['backup_id']}")
    if "total_bytes" in ev and "limit_bytes" in ev:
        lines.append(f"Tamaño: {ev['total_bytes']} B (límite {ev['limit_bytes']} B)")
    if "action" in ev:
        lines.append(f"Acción: {ev['action']}")
    lines += ["Servicio: productor db-backup-remote (equipo MainSpot)", f"Hora (UTC): {ev['ts']}"]
    if ack:
        lines.append(f"Pulsa «{ACK_BUTTON}» para acusar recibo.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------
# Registro durable (API-0007)
# ---------------------------------------------------------------------------------------------

def _private_dir(path: Path) -> None:
    missing = []
    probe = path
    while not os.path.lexists(probe):
        missing.append(probe)
        probe = probe.parent
    for d in reversed(missing):               # 0700 explícito: no depender del umask (002 en este equipo)
        try:
            os.mkdir(d, 0o700)
        except FileExistsError:
            pass
        os.chmod(d, 0o700, follow_symlinks=False)
    st = os.lstat(path)
    parent = os.stat(path.parent)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Exit(11, "state-dir-insecure")
    if parent.st_uid not in (0, os.getuid()) or parent.st_mode & 0o022:
        raise Exit(11, "state-dir-parent-insecure")


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    _fsync_dir(path.parent)


def _read_private(path: Path) -> bytes | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise Corrupt("insecure-file")
        with os.fdopen(fd, "rb", closefd=False) as fh:
            return fh.read(MAX_RESPONSE_BYTES * 4)
    finally:
        os.close(fd)


class Ledger:
    def __init__(self, root: Path):
        self.root, self.events = root, root / "events"

    @staticmethod
    def open(cfg: dict, home: Path) -> "Ledger":
        root = Path(cfg["ALERT_STATE_DIR"]) if cfg.get("ALERT_STATE_DIR") else home / STATE_REL
        try:
            _private_dir(root)
            _private_dir(root / "events")
        except OSError:
            raise Exit(11, "state-dir-unusable")
        return Ledger(root)

    @contextlib.contextmanager
    def lock(self, name: str = "state.lock", wait: bool = True):
        fd = os.open(self.root / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            limit = time.monotonic() + LOCK_TIMEOUT_S
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if not wait:
                        raise Busy(name)
                    if time.monotonic() > limit:
                        raise Exit(13, "state-lock-timeout")
                    time.sleep(0.05)
            yield
        finally:
            os.close(fd)

    def load(self, event_id: str) -> dict | None:
        raw = _read_private(self.events / f"{event_id}.json")
        if raw is None:
            return None
        try:
            rec = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise Corrupt("not-json")
        ok = (isinstance(rec, dict) and rec.get("schema") == SCHEMA and rec.get("event_id") == event_id
              and rec.get("state") in TRANSITIONS and isinstance(rec.get("receipts"), list)
              and isinstance(rec.get("history"), list) and isinstance(rec.get("event"), dict)
              and all(isinstance(r, dict) and is_int(r.get("message_id")) and is_int(r.get("date"))
                      for r in rec["receipts"]))
        if not ok:
            raise Corrupt("schema")
        return rec

    def save(self, rec: dict) -> None:
        _atomic_write(self.events / f"{rec['event_id']}.json",
                      json.dumps(rec, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def audit(self, entry: dict, ts: float) -> None:
        line = json.dumps({"at": iso(ts), **entry}, sort_keys=True, separators=(",", ":")) + "\n"
        fd = os.open(self.root / "audit.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.write(fd, line.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)

    def cursor(self) -> dict:
        try:
            raw = _read_private(self.root / "cursor.json")
            cur = json.loads(raw.decode("utf-8")) if raw else {}
        except (Corrupt, UnicodeDecodeError, ValueError):
            raise Exit(11, "cursor-corrupt")
        offset = cur.get("offset", 0)
        last = cur.get("last_poll_ts")
        if not is_int(offset) or offset < 0 or not (last is None or is_int(last)):
            raise Exit(11, "cursor-corrupt")
        return {"offset": offset, "last_poll_ts": last}

    def set_cursor(self, offset: int | None, poll_ts: float) -> None:
        cur = self.cursor()
        if offset is not None and offset > cur["offset"]:
            cur["offset"] = offset      # el cursor nunca retrocede
        cur["last_poll_ts"] = int(poll_ts)
        _atomic_write(self.root / "cursor.json", json.dumps(cur, sort_keys=True).encode("utf-8"))

    def ids(self) -> list[str]:
        return sorted(n[:-5] for n in os.listdir(self.events) if RECORD_RE.match(n))


def transition(rec: dict, to: str, reason: str, ts: float) -> None:
    frm = rec["state"]
    if to not in TRANSITIONS[frm]:
        raise AssertionError(f"transición no permitida {frm}->{to}")
    rec["state"] = to
    rec["history"].append({"at": int(ts), "from": frm, "to": to, "reason": reason})


def new_record(ev: dict, ts: float) -> dict:
    return {"schema": SCHEMA, "event_id": ev["event_id"], "event": ev, "requires_ack": requires_ack(ev),
            "ack_capable": False, "ack_unavailable_reason": None, "created_ts": int(ts), "deadline_ts": None,
            "state": "created", "in_flight": False, "attempts": 0, "unbound_sends": 0, "receipts": [],
            "ack": None, "reminders_sent": 0, "last_reminder_ts": None,
            "history": [{"at": int(ts), "from": None, "to": "created", "reason": "event_received"}]}


def receipt_view(rec: dict) -> dict:
    first = rec["receipts"][0] if rec["receipts"] else None
    state = rec["state"]
    if state in ACKED:
        ack = "acknowledged"
    elif not rec["requires_ack"]:
        ack = "not_required"
    elif state in ("created", "send_failed", "misrouted"):
        ack = "not_applicable"                 # no hay mensaje en el chat que acusar
    elif rec["ack_capable"]:
        ack = "pending"
    else:
        ack = f"unavailable:{rec['ack_unavailable_reason']}"
    return {"event_id": rec["event_id"], "state": state,
            "message_id": first["message_id"] if first else None,
            "message_date": first["date"] if first else None,
            "api_accepted": state in ACCEPTED, "human_acknowledged": state in ACKED, "ack": ack}


def emit(obj: dict) -> None:
    print(json.dumps(obj, sort_keys=True, separators=(",", ":")), flush=True)


# ---------------------------------------------------------------------------------------------
# Telegram (HTTPS)
# ---------------------------------------------------------------------------------------------

class Telegram:
    def __init__(self, cfg: dict):
        self.ctx = ssl.create_default_context()
        if cfg.get("TELEGRAM_CA_FILE"):
            self.ctx.load_verify_locations(cafile=cfg["TELEGRAM_CA_FILE"])
        self.base = f"{cfg['TELEGRAM_API_BASE']}/bot{cfg['TELEGRAM_BOT_TOKEN']}/"

    def call(self, method: str, payload: dict, timeout: float = CONNECT_READ_TIMEOUT_S,
             max_bytes: int = MAX_RESPONSE_BYTES) -> tuple[str, int | None, object]:
        """(kind, status, data). kind: ok | http | not_sent | uncertain | bad_json.

        `not_sent`: falló antes de completar la petición (urllib envuelve en URLError los errores de
        conexión, TLS y escritura). `uncertain`: la petición salió y la respuesta se perdió."""
        req = urllib.request.Request(self.base + method, data=json.dumps(payload).encode("utf-8"),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            resp = urllib.request.urlopen(req, timeout=timeout, context=self.ctx)
        except urllib.error.HTTPError as exc:  # nunca se imprime exc (su url contiene el token)
            try:
                body = json.loads(exc.read(4096).decode("utf-8"))
            except (ValueError, UnicodeDecodeError, OSError):
                body = None
            return "http", exc.code, body
        except (urllib.error.URLError, ValueError):
            return "not_sent", None, None
        except (OSError, http.client.HTTPException):
            return "uncertain", None, None
        try:
            with resp:
                raw = resp.read(max_bytes + 1)
                status = resp.status
        except (OSError, http.client.HTTPException):
            return "uncertain", None, None
        if len(raw) > max_bytes:
            return "uncertain", status, None
        try:
            return "ok", status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return "bad_json", status, None


def classify_receipt(cfg: dict, result: object) -> tuple[int, str, dict | None]:
    if not isinstance(result, dict):
        return 15, "receipt-missing", None
    chat = result.get("chat")
    cid = chat.get("id") if isinstance(chat, dict) else None
    if not is_int(cid):
        return 15, "receipt-chat-missing", None
    if cid != cfg["_chat"]:
        return 14, "receipt-chat-mismatch", None
    mid, date = result.get("message_id"), result.get("date")
    if not is_int(mid) or mid <= 0:
        return 15, "receipt-message-id-invalid", None
    wall = time.time()
    if not is_int(date) or date < DATE_MIN or date > wall + DATE_FUTURE_SLACK_S or date < wall - DATE_PAST_WINDOW_S:
        return 15, "receipt-date-invalid", None
    return 0, "receipt-valid", {"message_id": mid, "date": date}


def send_message(tg: Telegram, cfg: dict, text: str, markup: dict | None) -> tuple[int, str, dict | None]:
    payload: dict = {"chat_id": cfg["TELEGRAM_CHAT_ID"], "text": text, "disable_web_page_preview": True}
    if markup:
        payload["reply_markup"] = markup
    last = "unavailable"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        kind, status, data = tg.call("sendMessage", payload)
        if kind in ("uncertain", "bad_json"):
            return 15, f"acceptance-uncertain-{kind}", None      # sin reenvío (ADR-0004)
        if kind == "http":
            if status in (400, 401, 403, 404):
                return 11, f"credentials-rejected-http{status}", None
            last = f"provider-http{status}"
            if status == 429:
                try:
                    wait = int(data.get("parameters", {}).get("retry_after", 0))  # type: ignore[union-attr]
                except (AttributeError, TypeError, ValueError):
                    wait = MAX_RETRY_AFTER_S + 1
                if not 0 <= wait <= MAX_RETRY_AFTER_S:
                    break
                time.sleep(wait)
                continue
        elif kind == "ok":
            if isinstance(data, dict) and data.get("ok") is True:
                return classify_receipt(cfg, data.get("result"))
            last = "provider-not-ok"
        else:
            last = "network-not-sent"
        if attempt < MAX_ATTEMPTS:
            time.sleep(RETRY_SLEEP_S)
    return 13, last, None


# ---------------------------------------------------------------------------------------------
# Envío (API-0005)
# ---------------------------------------------------------------------------------------------

def cmd_send(ev: dict, cfg: dict, home: Path) -> int:
    ledger = Ledger.open(cfg, home)
    key, reason = ack_setup(cfg, home)
    eid = ev["event_id"]
    t = now()
    tracked = True
    try:
        with ledger.lock():
            try:
                rec = ledger.load(eid)
            except Corrupt:
                raise Exit(15, "state-record-corrupt")
            if rec is not None:
                if rec["event"] != ev:
                    raise Exit(12, "event-id-conflict")
                if rec["state"] in ACCEPTED:
                    emit({"receipt": receipt_view(rec)})
                    return 0                                    # idempotente: no se reenvía
                if rec["state"] == "misrouted":
                    emit({"receipt": receipt_view(rec)})
                    return 14
                if rec["state"] == "api_acceptance_uncertain":
                    emit({"receipt": receipt_view(rec)})
                    return 15
                if rec["in_flight"]:                            # envío interrumpido sin resultado
                    rec["in_flight"] = False
                    rec["unbound_sends"] += 1
                    transition(rec, "api_acceptance_uncertain", "interrupted_send", t)
                    if rec["ack_capable"] and rec["deadline_ts"] is None and cfg["_policy"]:
                        rec["deadline_ts"] = int(t) + cfg["_policy"]["ACK_DEADLINE_SECONDS"]
                    ledger.save(rec)
                    ledger.audit({"kind": "send", "event_id": eid, "outcome": rec["state"], "reason": "interrupted_send"}, t)
                    emit({"receipt": receipt_view(rec)})
                    return 15
            else:
                rec = new_record(ev, t)
            capable = rec["requires_ack"] and key is not None
            rec["ack_capable"] = capable
            rec["ack_unavailable_reason"] = reason if rec["requires_ack"] and not capable else None
            rec["in_flight"] = True
            rec["attempts"] += 1
            ledger.save(rec)
    except OSError:
        # Registro no escribible (p. ej. disco lleno): se prioriza la entrega (DEC-0065) y el
        # resultado se informa como «sin seguimiento».
        tracked = False
        rec = new_record(ev, t)
        capable = rec["requires_ack"] and key is not None
    markup = ack_markup(key, eid) if tracked and capable and key is not None else None
    code, why, receipt = send_message(Telegram(cfg), cfg, render(ev, ack=markup is not None), markup)
    t2 = now()
    if tracked:
        try:
            with ledger.lock():
                rec = ledger.load(eid)
                if rec is None:
                    raise Corrupt("vanished")
                rec["in_flight"] = False
                if rec["state"] not in ("created", "send_failed"):
                    # Otro proceso declaró incierto este envío mientras estaba en vuelo: se conserva su
                    # estado y, si llegó recibo, se vincula sin transición nueva.
                    if code == 0:
                        rec["receipts"].append({**receipt, "kind": "initial", "recorded_ts": int(t2)})
                        rec["unbound_sends"] = max(0, rec["unbound_sends"] - 1)
                elif code == 0:
                    rec["receipts"].append({**receipt, "kind": "initial", "recorded_ts": int(t2)})
                    transition(rec, "api_accepted", "telegram_receipt_valid", t2)
                elif code == 14:
                    transition(rec, "misrouted", why, t2)
                elif code == 15:
                    rec["unbound_sends"] += 1
                    transition(rec, "api_acceptance_uncertain", why, t2)
                else:
                    transition(rec, "send_failed", why, t2)
                if code == 0 and rec["state"] == "api_accepted" and rec["requires_ack"] and not rec["ack_capable"]:
                    transition(rec, "needs_operator_attention", f"ack_unavailable:{rec['ack_unavailable_reason']}", t2)
                if code in (0, 15) and rec["ack_capable"] and rec["deadline_ts"] is None:
                    rec["deadline_ts"] = int(t2) + cfg["_policy"]["ACK_DEADLINE_SECONDS"]
                ledger.save(rec)
                entry = {"kind": "send", "event_id": eid, "outcome": rec["state"], "reason": why}
                if receipt:
                    entry["message_id"] = receipt["message_id"]
                ledger.audit(entry, t2)
        except (OSError, Corrupt):
            tracked = False
    if not tracked:
        if code == 0:
            emit({"receipt": {"event_id": eid, "state": "api_accepted_untracked", "message_id": receipt["message_id"],
                              "message_date": receipt["date"], "api_accepted": True, "human_acknowledged": False,
                              "ack": "untracked"}})
            return 16
        print(f"remote-alert-telegram: {why} (sin registro)", file=sys.stderr)
        return code
    emit({"receipt": receipt_view(rec)})
    if code:
        print(f"remote-alert-telegram: {why}", file=sys.stderr)
    return code


# ---------------------------------------------------------------------------------------------
# Acuse por callback (API-0006)
# ---------------------------------------------------------------------------------------------

def process_update(ledger: Ledger, key: bytes, cfg: dict, update: dict, t: float) -> dict:
    """Valida un update y persiste su efecto. Devuelve la acción de interfaz (sin persistir)."""
    uid = update["update_id"]
    cq = update.get("callback_query")
    if not isinstance(cq, dict):
        ledger.audit({"kind": "update_ignored", "update_id": uid}, t)
        return {"outcome": "ignored"}
    cq_id = cq.get("id") if isinstance(cq.get("id"), str) and 0 < len(cq["id"]) <= 128 else None

    def reject(reason: str, eid: str | None = None) -> dict:
        entry = {"kind": "ack_rejected", "update_id": uid, "reason": reason}
        if eid:                                  # solo tras verificar la firma
            entry["event_id"] = eid
        ledger.audit(entry, t)
        return {"outcome": "rejected", "reason": reason, "cq_id": cq_id}

    frm, msg, data = cq.get("from"), cq.get("message"), cq.get("data")
    if not isinstance(frm, dict) or not is_int(frm.get("id")):
        return reject("malformed_from")
    if (not isinstance(msg, dict) or not is_int(msg.get("message_id")) or not is_int(msg.get("date"))
            or not isinstance(msg.get("chat"), dict) or not is_int(msg["chat"].get("id"))):
        return reject("malformed_message")
    if not isinstance(data, str) or len(data.encode("utf-8")) > 64:
        return reject("malformed_data")
    m = CALLBACK_RE.match(data)
    if not m:
        return reject("bad_format")
    eid, tag = m.groups()
    if not hmac.compare_digest(ack_tag(key, eid), tag):
        return reject("bad_signature")
    if frm.get("is_bot") is not False or frm["id"] != cfg["_user"]:
        return reject("actor_not_authorized", eid)
    if msg["chat"]["id"] != cfg["_chat"]:
        return reject("chat_not_authorized", eid)
    mid, mdate = msg["message_id"], msg["date"]
    with ledger.lock():
        try:
            rec = ledger.load(eid)
        except Corrupt:
            return reject("record_corrupt", eid)
        if rec is None:
            return reject("unknown_event", eid)
        if not (rec["requires_ack"] and rec["ack_capable"]):
            return reject("ack_not_expected", eid)
        bound = next((r for r in rec["receipts"] if r["message_id"] == mid), None)
        if bound is None:
            # Solo un envío sin recibo (aceptación incierta) puede recuperarse desde el callback.
            if rec["unbound_sends"] <= 0 or mdate < rec["created_ts"] - DATE_FUTURE_SLACK_S:
                return reject("message_not_bound", eid)
            rec["unbound_sends"] -= 1
            rec["receipts"].append({"message_id": mid, "date": mdate, "kind": "recovered", "recorded_ts": int(t)})
        elif bound["date"] != mdate:
            return reject("message_date_mismatch", eid)
        if rec["state"] in ACKED:
            if bound is None:
                ledger.save(rec)
            ledger.audit({"kind": "ack_duplicate", "update_id": uid, "event_id": eid, "message_id": mid}, t)
            return {"outcome": "duplicate", "cq_id": cq_id, "message_id": mid}
        if rec["state"] not in ACKABLE:
            return reject("state_not_ackable", eid)
        late = rec["deadline_ts"] is not None and t >= rec["deadline_ts"]
        if rec["state"] in ("api_accepted", "api_acceptance_uncertain"):
            if late:   # el vencimiento ocurrió aunque nadie lo evaluara: se conserva en el historial
                transition(rec, "ack_overdue", "deadline_passed_detected_at_ack", rec["deadline_ts"])
                transition(rec, "acknowledged_late", "human_ack", t)
            else:
                transition(rec, "human_acknowledged", "human_ack", t)
        else:
            transition(rec, "acknowledged_late", "human_ack", t)
        rec["ack"] = {"ts": int(t), "message_id": mid, "update_id": uid,
                      "actor_ref": actor_ref(key, frm["id"]), "late": rec["state"] == "acknowledged_late"}
        ledger.save(rec)                      # el acuse se persiste antes de avanzar el cursor
        ledger.audit({"kind": "ack_accepted", "update_id": uid, "event_id": eid, "message_id": mid,
                      "state": rec["state"], "actor_ref": rec["ack"]["actor_ref"]}, t)
    return {"outcome": "accepted", "cq_id": cq_id, "message_id": mid, "late": rec["state"] == "acknowledged_late"}


def ui_feedback(tg: Telegram, cfg: dict, action: dict) -> None:
    """Solo interfaz: nunca altera el estado persistido."""
    if not action.get("cq_id"):
        return
    text = {"accepted": "Recepción confirmada", "duplicate": "Recepción ya confirmada",
            "rejected": "No se pudo validar el acuse"}[action["outcome"]]
    tg.call("answerCallbackQuery", {"callback_query_id": action["cq_id"], "text": text})
    if action["outcome"] in ("accepted", "duplicate"):
        tg.call("editMessageReplyMarkup", {"chat_id": cfg["TELEGRAM_CHAT_ID"], "message_id": action["message_id"],
                                           "reply_markup": {"inline_keyboard": []}})


def cmd_ack_poll(cfg: dict, home: Path, max_seconds: int) -> int:
    key, reason = ack_setup(cfg, home)
    if key is None:
        raise Exit(11, f"ack-not-configured:{reason}")
    ledger = Ledger.open(cfg, home)
    stats = {"accepted": 0, "duplicate": 0, "rejected": 0, "ignored": 0}
    try:
        with ledger.lock("poller.lock", wait=False):
            tg = Telegram(cfg)
            kind, status, data = tg.call("getWebhookInfo", {})
            if kind == "http" and status in (401, 403, 404):
                raise Exit(11, f"credentials-rejected-http{status}")
            if kind != "ok" or not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("result"), dict):
                raise Exit(13, "webhook-info-unavailable")
            if data["result"].get("url"):
                raise Exit(17, "webhook-configured")
            end = time.monotonic() + max_seconds
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    break
                timeout = int(max(0, min(POLL_TIMEOUT_S, remaining - 1)))
                offset = ledger.cursor()["offset"]
                payload: dict = {"timeout": timeout, "allowed_updates": ["callback_query"]}
                if offset:
                    payload["offset"] = offset
                kind, status, data = tg.call("getUpdates", payload, timeout=timeout + CONNECT_READ_TIMEOUT_S,
                                             max_bytes=MAX_UPDATES_BYTES)
                if kind == "http" and status == 409:
                    raise Exit(17, "getupdates-conflict")
                if kind == "http" and status in (401, 403, 404):
                    raise Exit(11, f"credentials-rejected-http{status}")
                if kind != "ok" or not isinstance(data, dict) or data.get("ok") is not True or not isinstance(data.get("result"), list):
                    raise Exit(13, "getupdates-unavailable")
                updates = sorted((u for u in data["result"] if isinstance(u, dict) and is_int(u.get("update_id"))),
                                 key=lambda u: u["update_id"])
                ledger.set_cursor(None, now())
                for update in updates:
                    if update["update_id"] < offset:
                        continue                       # ya procesado (redelivery)
                    action = process_update(ledger, key, cfg, update, now())
                    offset = update["update_id"] + 1
                    ledger.set_cursor(offset, now())
                    stats[action["outcome"]] += 1
                    if action["outcome"] != "ignored":
                        ui_feedback(tg, cfg, action)
                if not updates and timeout == 0:
                    break
    except Busy:
        raise Exit(17, "another-consumer")
    emit({"ack_poll": stats})
    return 0


# ---------------------------------------------------------------------------------------------
# Vencimientos, recordatorios y estado (API-0008)
# ---------------------------------------------------------------------------------------------

def build_status(ledger: Ledger, cfg: dict, t: float) -> dict:
    counts: dict[str, int] = {}
    unacked = []
    attention = False
    pending_ack = False
    for eid in ledger.ids():
        try:
            rec = ledger.load(eid)
        except Corrupt:
            counts["corrupt"] = counts.get("corrupt", 0) + 1
            attention = True
            continue
        if rec is None:
            continue
        st = rec["state"]
        counts[st] = counts.get(st, 0) + 1
        attention |= st in ATTENTION
        if rec["requires_ack"] and st not in ACKED:
            pending_ack |= rec["ack_capable"] and st in ("api_accepted", "api_acceptance_uncertain")
            unacked.append({"event_id": eid, "code": rec["event"]["code"], "state": st,
                            "age_s": int(t - rec["created_ts"]),
                            "deadline_in_s": None if rec["deadline_ts"] is None else int(rec["deadline_ts"] - t),
                            "reminders_sent": rec["reminders_sent"]})
    last = ledger.cursor()["last_poll_ts"]
    policy = cfg["_policy"]
    stale = last is None or (policy is not None and t - last > policy["ACK_DEADLINE_SECONDS"])
    attention |= pending_ack and stale
    return {"schema": "mainspot-alert-status/v1", "now": iso(t), "counts": counts, "unacknowledged": unacked,
            "ack_processor": {"last_poll_at": iso(last), "stale": stale}, "attention": attention}


def cmd_check_overdue(cfg: dict, home: Path) -> int:
    key, reason = ack_setup(cfg, home)
    if key is None:
        raise Exit(11, f"ack-not-configured:{reason}")
    policy = cfg["_policy"]
    interval, max_rem = policy["ACK_REMINDER_INTERVAL_SECONDS"], policy["ACK_MAX_REMINDERS"]
    ledger = Ledger.open(cfg, home)
    sent = 0
    try:
        with ledger.lock("overdue.lock", wait=False):
            tg = Telegram(cfg)
            for eid in ledger.ids():
                t = now()
                with ledger.lock():
                    try:
                        rec = ledger.load(eid)
                    except Corrupt:
                        continue
                    if rec is None or not (rec["requires_ack"] and rec["ack_capable"]):
                        continue
                    if rec["state"] == "ack_overdue" and rec["in_flight"]:
                        # Recordatorio interrumpido (overdue.lock garantiza que no hay otro en curso).
                        rec["in_flight"] = False
                        rec["unbound_sends"] += 1
                        ledger.save(rec)
                        ledger.audit({"kind": "reminder", "event_id": eid, "outcome": "interrupted"}, t)
                    if (rec["state"] in ("api_accepted", "api_acceptance_uncertain") and rec["deadline_ts"] is not None
                            and t >= rec["deadline_ts"]):
                        transition(rec, "ack_overdue", "deadline_passed", t)
                        ledger.save(rec)
                        ledger.audit({"kind": "overdue", "event_id": eid}, t)
                    if rec["state"] != "ack_overdue":
                        continue
                    ref = rec["last_reminder_ts"] if rec["last_reminder_ts"] is not None else rec["deadline_ts"]
                    if rec["reminders_sent"] >= max_rem:
                        if t >= ref + interval:
                            transition(rec, "needs_operator_attention", "reminders_exhausted", t)
                            ledger.save(rec)
                            ledger.audit({"kind": "needs_operator_attention", "event_id": eid,
                                          "reason": "reminders_exhausted"}, t)
                        continue
                    due = rec["last_reminder_ts"] is None or t >= rec["last_reminder_ts"] + interval
                    if not due or sent >= MAX_REMINDERS_PER_RUN:
                        continue
                    n = rec["reminders_sent"] + 1
                    rec["reminders_sent"], rec["last_reminder_ts"], rec["in_flight"] = n, int(t), True
                    ledger.save(rec)
                    ev = rec["event"]
                code, why, receipt = send_message(tg, cfg, render(ev, ack=True, reminder=(n, max_rem)),
                                                  ack_markup(key, eid))
                sent += 1
                t2 = now()
                with ledger.lock():
                    try:
                        rec = ledger.load(eid)
                    except Corrupt:
                        rec = None
                    if rec is None:
                        continue
                    rec["in_flight"] = False
                    if code == 0:
                        rec["receipts"].append({**receipt, "kind": "reminder", "recorded_ts": int(t2)})
                    elif code == 15:
                        rec["unbound_sends"] += 1
                    elif code == 14 and rec["state"] == "ack_overdue":
                        transition(rec, "needs_operator_attention", "reminder_misrouted", t2)
                    ledger.save(rec)
                    entry = {"kind": "reminder", "event_id": eid, "n": n, "outcome": "api_accepted" if code == 0 else why}
                    if receipt:
                        entry["message_id"] = receipt["message_id"]
                    ledger.audit(entry, t2)
            status = build_status(ledger, cfg, now())
    except Busy:
        raise Exit(17, "another-overdue-check")
    status["reminders_sent_this_run"] = sent
    emit(status)
    return 18 if status["attention"] else 0


def cmd_status(cfg: dict, home: Path) -> int:
    status = build_status(Ledger.open(cfg, home), cfg, now())
    emit(status)
    return 18 if status["attention"] else 0


# ---------------------------------------------------------------------------------------------

def synthetic_event() -> bytes:
    """Evento TEST-SYNTHETIC para la prueba de recepción real (DEC-0065); no toca respaldos ni S3."""
    ev = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "producer": "db-backup-remote",
          "event_id": os.urandom(16).hex(), "code": "TEST-SYNTHETIC", "severity": "info",
          "action": "synthetic-delivery-test"}
    return json.dumps(ev).encode("utf-8")


USAGE = ("uso: remote-alert-telegram.py [--synthetic-test | --ack-poll [--max-seconds N] | --check-overdue | --status]"
         "  (sin argumentos: evento JSON por stdin)")


def main(argv: list[str]) -> int:
    try:
        home = Path(os.environ.get("HOME") or "/nonexistent")
        if argv in ([], ["--synthetic-test"]):
            raw = synthetic_event() if argv else sys.stdin.buffer.read(MAX_EVENT_BYTES + 1)
            ev = validate_event(raw)
            rc = cmd_send(ev, load_config(home), home)
            if argv and rc in (0, 16):
                print(f"remote-alert-telegram: enviado TEST-SYNTHETIC id={ev['event_id']}", file=sys.stderr)
            return rc
        if argv[:1] == ["--ack-poll"] and (len(argv) == 1 or (len(argv) == 3 and argv[1] == "--max-seconds"
                                                               and re.fullmatch(r"[0-9]{1,4}", argv[2]))):
            secs = int(argv[2]) if len(argv) == 3 else 50
            if not 1 <= secs <= MAX_POLL_SECONDS:
                raise Exit(12, "max-seconds-out-of-range")
            return cmd_ack_poll(load_config(home), home, secs)
        if argv == ["--check-overdue"]:
            return cmd_check_overdue(load_config(home), home)
        if argv == ["--status"]:
            return cmd_status(load_config(home), home)
        print(USAGE, file=sys.stderr)
        return 12
    except Exit as exc:
        print(f"remote-alert-telegram: {exc.reason}", file=sys.stderr)
        return exc.code
    except OSError as exc:                      # E/S del registro: el cursor no avanza (redelivery idempotente)
        print(f"remote-alert-telegram: state-io-error-{type(exc).__name__}", file=sys.stderr)
        return 13


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
