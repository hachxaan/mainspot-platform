#!/usr/bin/env python3
"""remote-alert-telegram.py — adaptador de avisos del productor remoto de MainSpot a Telegram.

DEC-0064 / DEC-0065: bot de Telegram exclusivo de los avisos del productor, con chat privado;
el token y el identificador del chat viven solo en el equipo de MainSpot. Lo invoca
`db-backup-remote.py` como `MAINSPOT_REMOTE_ALERT_COMMAND` (sin shell, sin argumentos, entorno
mínimo) con un evento JSON por stdin; envía un único mensaje de texto plano por HTTPS y termina.
`--synthetic-test` envía en su lugar un evento TEST-SYNTHETIC (prueba de recepción real, DEC-0065).

Configuración (archivo regular del usuario, permisos 0600, en un directorio no escribible por
grupo ni otros): `$HOME/.config/mainspot/backup/telegram-alert.env`

    TELEGRAM_BOT_TOKEN=…        (bot exclusivo de este productor; nunca en Git ni registros)
    TELEGRAM_CHAT_ID=…          (chat privado del propietario)
    TELEGRAM_API_BASE=https://api.telegram.org   (opcional; siempre https://)
    TELEGRAM_CA_FILE=…          (opcional; solo laboratorio: CA adicional de confianza)

Códigos de salida (el productor los traduce a `delivery=`):
  0  entregado (Telegram respondió ok)
  10 sin configurar (no existe el archivo de configuración)
  11 configuración insegura o inválida, o credenciales rechazadas por Telegram (401/403/404/400)
  12 evento inválido (no se reintenta)
  13 Telegram no disponible (red, tiempo agotado, 429, 5xx): el productor lo conserva y reintenta

Nunca imprime el token, el identificador del chat ni la URL de la API; stderr solo lleva un motivo
corto sin datos.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

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
CONNECT_READ_TIMEOUT_S = 8
MAX_ATTEMPTS = 2           # intento acotado en la misma ejecución (DEC-0065)
RETRY_SLEEP_S = 2
MAX_RETRY_AFTER_S = 5      # un 429 con espera mayor se trata como «no disponible»
MAX_EVENT_BYTES = 4096

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


class Exit(Exception):
    def __init__(self, code: int, reason: str):
        super().__init__(reason)
        self.code, self.reason = code, reason


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
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v < 1 << 50:
                raise Exit(12, "event-bad-integer")
        elif k in FIELD_RE:
            if not isinstance(v, str) or not FIELD_RE[k].match(v):
                raise Exit(12, "event-bad-field")
    return ev


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


def load_config(home: Path) -> dict[str, str]:
    path = home / CONFIG_REL
    private_file(path)
    values: dict[str, str] = {}
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
    return values


def render(ev: dict) -> str:
    sev = {"error": "ERROR", "warning": "AVISO", "info": "INFO"}[ev["severity"]]
    lines = [f"MainSpot · respaldos remotos · {sev}", f"Código: {ev['code']}"]
    if "backup_id" in ev:
        lines.append(f"Respaldo: {ev['backup_id']}")
    if "total_bytes" in ev and "limit_bytes" in ev:
        lines.append(f"Tamaño: {ev['total_bytes']} B (límite {ev['limit_bytes']} B)")
    if "action" in ev:
        lines.append(f"Acción: {ev['action']}")
    lines += ["Servicio: productor db-backup-remote (equipo MainSpot)", f"Hora (UTC): {ev['ts']}",
              f"Id: {ev['event_id']}"]
    return "\n".join(lines)


def send(cfg: dict[str, str], text: str) -> None:
    ctx = ssl.create_default_context()
    if cfg.get("TELEGRAM_CA_FILE"):
        ctx.load_verify_locations(cafile=cfg["TELEGRAM_CA_FILE"])
    url = f"{cfg['TELEGRAM_API_BASE']}/bot{cfg['TELEGRAM_BOT_TOKEN']}/sendMessage"
    body = json.dumps({"chat_id": cfg["TELEGRAM_CHAT_ID"], "text": text,
                       "disable_web_page_preview": True}).encode("utf-8")
    last = "unavailable"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=CONNECT_READ_TIMEOUT_S, context=ctx) as resp:
                data = json.loads(resp.read(65536).decode("utf-8") or "{}")
            if data.get("ok") is True:
                return
            last = "provider-not-ok"
        except urllib.error.HTTPError as exc:  # nunca se imprime exc (su url contiene el token)
            status = exc.code
            if status in (400, 401, 403, 404):
                raise Exit(11, f"credentials-rejected-http{status}")
            last = f"provider-http{status}"
            if status == 429:
                try:
                    wait = int(json.loads(exc.read(4096).decode("utf-8")).get("parameters", {}).get("retry_after", 0))
                except (ValueError, AttributeError, OSError):
                    wait = MAX_RETRY_AFTER_S + 1
                if wait > MAX_RETRY_AFTER_S:
                    break
                time.sleep(wait)
                continue
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
            last = f"network-{type(exc).__name__}"
        if attempt < MAX_ATTEMPTS:
            time.sleep(RETRY_SLEEP_S)
    raise Exit(13, last)


def synthetic_event() -> bytes:
    """Evento TEST-SYNTHETIC para la prueba de recepción real (DEC-0065); no toca respaldos ni S3."""
    ev = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "producer": "db-backup-remote",
          "event_id": os.urandom(16).hex(), "code": "TEST-SYNTHETIC", "severity": "info",
          "action": "synthetic-delivery-test"}
    return json.dumps(ev).encode("utf-8")


def main(argv: list[str]) -> int:
    if argv not in ([], ["--synthetic-test"]):
        print("uso: remote-alert-telegram.py [--synthetic-test]  (evento JSON por stdin)", file=sys.stderr)
        return 12
    try:
        raw = synthetic_event() if argv else sys.stdin.buffer.read(MAX_EVENT_BYTES + 1)
        ev = validate_event(raw)
        home = Path(os.environ.get("HOME") or "/nonexistent")
        cfg = load_config(home)
        send(cfg, render(ev))
        if argv:
            print(f"remote-alert-telegram: enviado TEST-SYNTHETIC id={ev['event_id']}")
        return 0
    except Exit as exc:
        print(f"remote-alert-telegram: {exc.reason}", file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
