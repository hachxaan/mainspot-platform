"""Pruebas del adaptador de avisos por Telegram (DEC-0064/DEC-0065) y del flujo de avisos del productor.

Sin red externa ni Garage: un Telegram falso por HTTPS en 127.0.0.1 (certificado autofirmado generado
aquí y confiado solo con TELEGRAM_CA_FILE) y un «S3» falso que responde 403 a todo, para que el productor
termine en segundos. Token y chat son sintéticos y desechables.

    PYTHONPYCACHEPREFIX=/tmp/omp-pyc python3 -m pytest -p no:cacheprovider -v tests/ops/backup-remote/test_alert_telegram.py
"""
from __future__ import annotations

import fcntl
import hashlib
import hmac
import http.server
import json
import os
import secrets
import shutil
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[3]
ADAPTER = REPO / "scripts" / "ops" / "backup" / "remote-alert-telegram.py"
PRODUCER = REPO / "scripts" / "ops" / "backup" / "db-backup-remote.py"
ENC_ARGS = ["-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-md", "sha256"]
TOKEN = f"{secrets.randbelow(10**9) + 10**9}:{secrets.token_urlsafe(30)[:35]}"
CHAT = str(secrets.randbelow(10**9) + 10**8)
SECRETS = {TOKEN, CHAT, TOKEN.split(":", 1)[1]}


# --- Telegram falso (HTTPS) ----------------------------------------------------------------

RECEIPT_FAULTS = ("other-chat", "no-chat", "no-message-id", "str-message-id", "bool-message-id", "zero-message-id",
                  "no-date", "bad-date", "future-date", "bad-json")


class FakeTelegram:
    """sendMessage con `result` completo (message_id, date, chat.id), getUpdates con cola y offset, webhook,
    answerCallbackQuery y editMessageReplyMarkup. `mode` gobierna sendMessage:
    ok | 401 | 400 | 500 | hang | drop-after-send | ok-false | 429-short | 429-long | RECEIPT_FAULTS."""

    def __init__(self, certdir: Path):
        self.mode = "ok"
        self.updates_mode = "ok"    # ok | 409
        self.ui_mode = "ok"         # ok | 500 (answerCallbackQuery / editMessageReplyMarkup)
        self.webhook_url = ""
        self.requests: list[tuple[str, dict]] = []
        self.sent: list[dict] = []  # mensajes que Telegram creó realmente en el chat del propietario
        self.updates: list[dict] = []
        self.next_mid = 100
        self.lock = threading.Lock()
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, status: int, payload: dict | None = None, raw: bytes | None = None):
                data = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                method = self.path.rsplit("/", 1)[-1]
                with fake.lock:
                    fake.requests.append((self.path, body))
                if method == "sendMessage":
                    return self.send_message(body)
                if method == "getWebhookInfo":
                    return self.reply(200, {"ok": True, "result": {"url": fake.webhook_url, "pending_update_count": 0}})
                if method == "getUpdates":
                    if fake.updates_mode == "409":
                        return self.reply(409, {"ok": False, "error_code": 409, "description": "Conflict"})
                    with fake.lock:
                        if body.get("offset"):
                            fake.updates = [u for u in fake.updates if u["update_id"] >= body["offset"]]
                        result = list(fake.updates[:100])
                    if not result:
                        time.sleep(min(body.get("timeout", 0), 0.2))
                    return self.reply(200, {"ok": True, "result": result})
                if method in ("answerCallbackQuery", "editMessageReplyMarkup"):
                    if fake.ui_mode == "500":
                        return self.reply(500, {"ok": False})
                    return self.reply(200, {"ok": True, "result": True})
                return self.reply(404, {"ok": False})

            def send_message(self, body: dict):
                mode = fake.mode
                n = len(fake.calls("sendMessage"))
                if mode == "hang":
                    time.sleep(12)
                    return
                if mode == "429-short" and n == 1:
                    return self.reply(429, {"ok": False, "parameters": {"retry_after": 1}})
                if mode == "429-long":
                    return self.reply(429, {"ok": False, "parameters": {"retry_after": 60}})
                if mode in ("401", "400", "500"):
                    return self.reply(int(mode), {"ok": False, "description": "lab"})
                if mode == "ok-false":
                    return self.reply(200, {"ok": False})
                with fake.lock:
                    fake.next_mid += 1
                    mid = fake.next_mid
                date = int(time.time())
                chat_id = int(CHAT) + 1 if mode == "other-chat" else int(CHAT)
                if mode != "other-chat":
                    fake.sent.append({"message_id": mid, "date": date, "text": body.get("text"),
                                      "reply_markup": body.get("reply_markup")})
                if mode == "drop-after-send":       # el mensaje existe, la respuesta se pierde
                    self.close_connection = True
                    return
                if mode == "bad-json":
                    return self.reply(200, raw=b"{not json")
                result = {"message_id": mid, "date": date, "chat": {"id": chat_id, "type": "private"},
                          "text": body.get("text")}
                if mode == "no-chat":
                    del result["chat"]
                elif mode == "no-message-id":
                    del result["message_id"]
                elif mode == "str-message-id":
                    result["message_id"] = str(mid)
                elif mode == "bool-message-id":
                    result["message_id"] = True
                elif mode == "zero-message-id":
                    result["message_id"] = 0
                elif mode == "no-date":
                    del result["date"]
                elif mode == "bad-date":
                    result["date"] = 1000
                elif mode == "future-date":
                    result["date"] = date + 3600
                return self.reply(200, {"ok": True, "result": result})

        self.cert = certdir / "cert.pem"
        key = certdir / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
                        "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", str(key), "-out", str(self.cert)],
                       check=True, capture_output=True)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(self.cert, key)
        self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
        self.base = f"https://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def calls(self, method: str) -> list[dict]:
        return [b for path, b in self.requests if path.endswith("/" + method)]

    def press(self, msg: dict, *, update_id: int | None = None, from_id: int | None = None, chat_id: int | None = None,
              data: str | None = None, message_id: int | None = None, date: int | None = None, is_bot: bool = False,
              drop: tuple[str, ...] = ()) -> dict:
        """Pulsación de «Confirmar recepción» tal como la entrega Telegram (callback_query)."""
        markup_data = msg["reply_markup"]["inline_keyboard"][0][0]["callback_data"] if msg.get("reply_markup") else None
        uid = update_id if update_id is not None else 1000 + len(self.updates) + len(self.requests)
        cq = {"id": secrets.token_hex(8), "from": {"id": int(CHAT) if from_id is None else from_id, "is_bot": is_bot,
                                                  "first_name": "lab"},
              "message": {"message_id": msg["message_id"] if message_id is None else message_id,
                          "date": msg["date"] if date is None else date,
                          "chat": {"id": int(CHAT) if chat_id is None else chat_id, "type": "private"}},
              "chat_instance": "lab", "data": markup_data if data is None else data}
        for k in drop:
            cq.pop(k, None)
        update = {"update_id": uid, "callback_query": cq}
        with self.lock:
            self.updates.append(update)
        return update

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class FakeS3Denied:
    """Responde 403 AccessDenied a todo: la ejecución del productor termina rápido (E-AUTH-DENIED)."""

    def __init__(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _deny(self):
                data = b"<?xml version='1.0'?><Error><Code>AccessDenied</Code><Message>lab</Message></Error>"
                self.send_response(403)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(data) if self.command != "HEAD" else 0))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)

            do_GET = do_HEAD = do_PUT = do_POST = _deny

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def tg(tmp_path):
    d = tmp_path / "tls"
    d.mkdir()
    f = FakeTelegram(d)
    yield f
    f.stop()


@pytest.fixture
def s3():
    f = FakeS3Denied()
    yield f
    f.stop()


# --- instalación privada del adaptador y configuración -------------------------------------

class Box:
    def __init__(self, root: Path, tg: FakeTelegram):
        self.root, self.tg = root, tg
        self.home = root / "home"
        cfgdir = self.home / ".config" / "mainspot" / "backup"
        cfgdir.mkdir(parents=True, mode=0o700)
        for p in (self.home, self.home / ".config", self.home / ".config" / "mainspot"):
            p.chmod(0o700)
        self.cfg = cfgdir / "telegram-alert.env"
        self.write_cfg(TELEGRAM_API_BASE=tg.base, TELEGRAM_CA_FILE=str(tg.cert))
        libexec = root / "libexec"
        libexec.mkdir(mode=0o700)
        self.adapter = libexec / "remote-alert-telegram.py"
        shutil.copy(ADAPTER, self.adapter)
        self.adapter.chmod(0o700)
        root.chmod(0o700)

    def write_cfg(self, **extra):
        values = {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_CHAT_ID": CHAT, **extra}
        self.cfg.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        self.cfg.chmod(0o600)

    def run_adapter(self, event: dict | bytes):
        data = event if isinstance(event, bytes) else (json.dumps(event) + "\n").encode()
        return subprocess.run([str(self.adapter)], input=data, capture_output=True, timeout=60,
                              env={"PATH": "/usr/bin:/bin", "HOME": str(self.home)})

    def enable_ack(self, deadline: int = 600, interval: int = 300, max_reminders: int = 2, **extra):
        self.ack_key = secrets.token_hex(32)
        SECRETS.add(self.ack_key)
        key = self.cfg.parent / "telegram-ack.key"
        key.write_text(self.ack_key + "\n")
        key.chmod(0o600)
        self.write_cfg(TELEGRAM_API_BASE=self.tg.base, TELEGRAM_CA_FILE=str(self.tg.cert),
                       ACK_DEADLINE_SECONDS=deadline, ACK_REMINDER_INTERVAL_SECONDS=interval,
                       ACK_MAX_REMINDERS=max_reminders, **extra)

    def cli(self, *args: str, now: float | None = None):
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home)}
        if now is not None:
            env["MAINSPOT_ALERT_LAB_NOW"] = str(int(now))
        return subprocess.run([str(self.adapter), *args], capture_output=True, text=True, timeout=120, env=env)

    def poll(self, now: float | None = None):
        return self.cli("--ack-poll", "--max-seconds", "1", now=now)

    @property
    def state_dir(self) -> Path:
        return self.home / ".local" / "state" / "mainspot" / "alerts"

    def record(self, eid: str) -> dict:
        return json.loads((self.state_dir / "events" / f"{eid}.json").read_text())

    def audit(self) -> list[dict]:
        p = self.state_dir / "audit.jsonl"
        return [json.loads(ln) for ln in p.read_text().splitlines()] if p.exists() else []

    def all_state_text(self) -> str:
        return "\n".join(f.read_text() for f in self.state_dir.rglob("*") if f.is_file() and not f.name.endswith(".lock"))


def event(**over) -> dict:
    ev = {"ts": "2026-10-24T21:00:00Z", "producer": "db-backup-remote", "event_id": secrets.token_hex(16),
          "code": "E-SIZE-LIMIT", "severity": "error", "backup_id": "mainspot-db-20261024T210000Z",
          "size_bytes": 10, "manifest_bytes": 2, "total_bytes": 12, "limit_bytes": 11,
          "action": "not-uploaded-local-backup-kept"}
    ev.update(over)
    return {k: v for k, v in ev.items() if v is not None}


def private_dirs(path: Path) -> None:
    """mkdir -p con 0700 en cada nivel nuevo (el umask del equipo puede ser 002)."""
    missing = []
    while not path.exists():
        missing.append(path)
        path = path.parent
    for d in reversed(missing):
        d.mkdir(mode=0o700)
        d.chmod(0o700)


def no_secrets(*blobs: str | bytes) -> None:
    joined = "\n".join(b.decode() if isinstance(b, bytes) else b for b in blobs)
    for s in SECRETS:
        assert s not in joined


# --- adaptador: envío y recibo (API-0005) -------------------------------------------------

def receipt(proc) -> dict:
    out = proc.stdout.decode() if isinstance(proc.stdout, bytes) else proc.stdout
    return json.loads(out.splitlines()[0])["receipt"]


def test_delivery_ok_plain_text_over_https(tmp_path, tg):
    box = Box(tmp_path, tg)
    ev = event()
    proc = box.run_adapter(ev)
    assert proc.returncode == 0, proc.stderr
    ((path, body),) = tg.requests
    assert path == f"/bot{TOKEN}/sendMessage" and body["chat_id"] == CHAT and "parse_mode" not in body
    assert body["text"].splitlines()[0] == f"ID: {ev['event_id']}"
    for needle in ("E-SIZE-LIMIT", ev["backup_id"], "12 B (límite 11 B)", "2026-10-24T21:00:00Z"):
        assert needle in body["text"]
    # Sin clave de acuse: sin botón y atención del operador; nunca acuse humano.
    assert "reply_markup" not in body
    r = receipt(proc)
    assert r["api_accepted"] is True and r["human_acknowledged"] is False
    assert r["message_id"] == tg.sent[0]["message_id"] and r["message_date"] == tg.sent[0]["date"]
    assert r["ack"] == "unavailable:ack_key_missing" and r["state"] == "needs_operator_attention"
    rec = box.record(ev["event_id"])
    assert rec["receipts"][0]["message_id"] == r["message_id"] and rec["ack"] is None
    assert oct(box.state_dir.stat().st_mode & 0o777) == "0o700"
    assert all(oct(f.stat().st_mode & 0o777) == "0o600" for f in box.state_dir.rglob("*") if f.is_file())
    no_secrets(body["text"], proc.stdout, proc.stderr, box.all_state_text())


@pytest.mark.parametrize("fault", RECEIPT_FAULTS)
def test_invalid_receipt_is_never_api_accepted_nor_resent(tmp_path, tg, fault):
    box = Box(tmp_path, tg)
    box.enable_ack()
    tg.mode = fault
    ev = event()
    proc = box.run_adapter(ev)
    expected = 14 if fault == "other-chat" else 15
    assert proc.returncode == expected and len(tg.calls("sendMessage")) == 1, proc.stderr
    r = receipt(proc)
    assert r["api_accepted"] is False and r["human_acknowledged"] is False and r["message_id"] is None
    assert box.record(ev["event_id"])["state"] == ("misrouted" if fault == "other-chat" else "api_acceptance_uncertain")
    # Un segundo intento del mismo evento no reenvía (sin duplicados no trazables, ADR-0004).
    tg.mode = "ok"
    assert box.run_adapter(ev).returncode == expected and len(tg.calls("sendMessage")) == 1
    no_secrets(proc.stdout, proc.stderr, box.all_state_text())


def test_lost_response_after_send_is_uncertain_and_bounded(tmp_path, tg):
    box = Box(tmp_path, tg)
    for mode in ("drop-after-send", "hang"):
        tg.mode, tg.requests = mode, []
        t0 = time.monotonic()
        proc = box.run_adapter(event())
        assert proc.returncode == 15 and len(tg.requests) == 1 and time.monotonic() - t0 < 20, (mode, proc.stderr)


def test_provider_not_ok_retries_once_then_unavailable(tmp_path, tg):
    box = Box(tmp_path, tg)
    for mode in ("500", "ok-false"):
        tg.mode, tg.requests = mode, []
        ev = event()
        proc = box.run_adapter(ev)
        assert proc.returncode == 13 and len(tg.requests) == 2
        assert box.record(ev["event_id"])["state"] == "send_failed"
        no_secrets(proc.stdout, proc.stderr)


def test_retry_after_send_failed_delivers_once_and_is_idempotent(tmp_path, tg):
    box = Box(tmp_path, tg)
    ev = event()
    tg.mode = "500"
    assert box.run_adapter(ev).returncode == 13
    tg.mode = "ok"
    first = box.run_adapter(ev)
    assert first.returncode == 0 and len(tg.sent) == 1
    again = box.run_adapter(ev)                  # p. ej. el productor cayó antes de borrar el pendiente
    assert again.returncode == 0 and len(tg.sent) == 1 and receipt(again)["message_id"] == receipt(first)["message_id"]
    tampered = dict(ev, action="other-action")    # mismo event_id, contenido distinto
    assert box.run_adapter(tampered).returncode == 12 and len(tg.sent) == 1


def test_crash_during_send_is_uncertain_not_resent(tmp_path, tg):
    box = Box(tmp_path, tg)
    ev = event()
    tg.mode = "hang"
    proc = subprocess.Popen([str(box.adapter)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={"PATH": "/usr/bin:/bin", "HOME": str(box.home)})
    proc.stdin.write((json.dumps(ev) + "\n").encode())
    proc.stdin.close()
    for _ in range(100):
        if tg.calls("sendMessage"):
            break
        time.sleep(0.05)
    proc.kill()
    proc.wait()
    assert box.record(ev["event_id"])["in_flight"] is True
    tg.mode = "ok"
    again = box.run_adapter(ev)
    assert again.returncode == 15 and len(tg.calls("sendMessage")) == 1
    rec = box.record(ev["event_id"])
    assert rec["state"] == "api_acceptance_uncertain" and rec["history"][-1]["reason"] == "interrupted_send"


def test_missing_insecure_or_invalid_configuration(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.cfg.chmod(0o644)
    assert box.run_adapter(event()).returncode == 11
    box.cfg.chmod(0o600)
    box.write_cfg(TELEGRAM_API_BASE=tg.base.replace("https", "http"), TELEGRAM_CA_FILE=str(tg.cert))
    assert box.run_adapter(event()).returncode == 11
    box.write_cfg(TELEGRAM_BOT_TOKEN="not-a-token", TELEGRAM_API_BASE=tg.base, TELEGRAM_CA_FILE=str(tg.cert))
    assert box.run_adapter(event()).returncode == 11
    box.cfg.unlink()
    proc = box.run_adapter(event())
    assert proc.returncode == 10 and b"not-configured" in proc.stderr
    assert tg.requests == []


@pytest.mark.parametrize("case", ["key-0644", "key-not-hex", "key-short", "policy-incomplete", "policy-out-of-range",
                                  "ack-user-invalid", "state-dir-0755", "state-dir-symlink", "state-dir-relative"])
def test_insecure_or_invalid_ack_setup_fails_closed_before_sending(tmp_path, tg, case):
    box = Box(tmp_path, tg)
    box.enable_ack()
    key = box.cfg.parent / "telegram-ack.key"
    base = {"TELEGRAM_API_BASE": tg.base, "TELEGRAM_CA_FILE": str(tg.cert)}
    if case == "key-0644":
        key.chmod(0o644)
    elif case == "key-not-hex":
        key.write_text("z" * 64)
    elif case == "key-short":
        key.write_text(secrets.token_hex(16))
    elif case == "policy-incomplete":
        box.write_cfg(**base, ACK_DEADLINE_SECONDS=600)
    elif case == "policy-out-of-range":
        box.write_cfg(**base, ACK_DEADLINE_SECONDS=5, ACK_REMINDER_INTERVAL_SECONDS=300, ACK_MAX_REMINDERS=2)
    elif case == "ack-user-invalid":
        box.enable_ack(TELEGRAM_ACK_USER_ID="-12")
    elif case == "state-dir-0755":
        private_dirs(box.state_dir)
        box.state_dir.chmod(0o755)
    elif case == "state-dir-symlink":
        target = tmp_path / "elsewhere"
        target.mkdir(mode=0o700)
        private_dirs(box.state_dir.parent)
        box.state_dir.symlink_to(target)
    elif case == "state-dir-relative":
        box.enable_ack(ALERT_STATE_DIR="relative/alerts")
    proc = box.run_adapter(event())
    assert proc.returncode == 11 and tg.requests == [], proc.stderr
    no_secrets(proc.stdout, proc.stderr)


def test_untrusted_certificate_is_not_delivered(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.write_cfg(TELEGRAM_API_BASE=tg.base)  # sin la CA del laboratorio: el certificado no es de confianza
    proc = box.run_adapter(event())
    assert proc.returncode == 13 and tg.requests == []


@pytest.mark.parametrize("mode", ["401", "400"])
def test_credentials_rejected_are_not_retried(tmp_path, tg, mode):
    box = Box(tmp_path, tg)
    tg.mode = mode
    proc = box.run_adapter(event())
    assert proc.returncode == 11 and len(tg.requests) == 1
    no_secrets(proc.stdout, proc.stderr)


def test_rate_limit_short_wait_is_honoured_long_wait_is_unavailable(tmp_path, tg):
    box = Box(tmp_path, tg)
    tg.mode = "429-short"
    assert box.run_adapter(event()).returncode == 0 and len(tg.requests) == 2
    tg.requests.clear()
    tg.mode = "429-long"
    assert box.run_adapter(event()).returncode == 13 and len(tg.requests) == 1


@pytest.mark.parametrize("bad", [
    event(action="$(touch PWNED)"),
    event(backup_id="mainspot-db-20261024T210000Z; touch PWNED"),
    event(code="E-NETWORK"),
    event(extra="field"),
    event(total_bytes="12"),
    b"not json",
    json.dumps(event(action="x" * 5000)).encode(),
])
def test_invalid_or_injected_events_are_rejected_without_sending(tmp_path, tg, bad):
    box = Box(tmp_path, tg)
    proc = box.run_adapter(bad)
    assert proc.returncode == 12 and tg.requests == []
    assert not list(tmp_path.rglob("PWNED")) and not (Path.cwd() / "PWNED").exists()


def test_synthetic_test_mode_sends_a_test_event_with_ack_button(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    proc = box.cli("--synthetic-test")
    assert proc.returncode == 0 and "TEST-SYNTHETIC" in proc.stderr, proc.stderr
    (msg,) = tg.sent
    assert "Código: TEST-SYNTHETIC" in msg["text"] and "INFO" in msg["text"] and msg["reply_markup"]
    r = receipt(proc)
    assert r["ack"] == "pending" and r["human_acknowledged"] is False
    no_secrets(proc.stdout, proc.stderr, msg["text"], json.dumps(msg["reply_markup"]))
    bad = box.cli("--anything")
    assert bad.returncode == 12 and len(tg.requests) == 1


def test_adapter_does_not_use_kvm4_channel(tmp_path, tg):
    """Independencia del canal del KVM 4 (DEC-0055/DEC-0058 §1): el adaptador solo lee su archivo propio."""
    box = Box(tmp_path, tg)
    box.cfg.unlink()
    kvm = box.home / ".config" / "mainspot" / "backup" / "garage-alert-telegram.env"
    kvm.write_text(f"TELEGRAM_BOT_TOKEN={TOKEN}\nTELEGRAM_CHAT_ID={CHAT}\n")
    kvm.chmod(0o600)
    assert box.run_adapter(event()).returncode == 10 and tg.requests == []
    assert "garage-alert" not in ADAPTER.read_text()


# --- acuse por botón (API-0006) -----------------------------------------------------------

def sent_with_ack(box: Box, tg: FakeTelegram, **over) -> tuple[dict, dict]:
    ev = event(**over)
    proc = box.run_adapter(ev)
    assert proc.returncode == 0, proc.stderr
    return ev, tg.sent[-1]


def test_ack_button_format_and_scope(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    ev, msg = sent_with_ack(box, tg)
    ((button,),) = msg["reply_markup"]["inline_keyboard"]
    assert button["text"] == "Confirmar recepción"
    data = button["callback_data"]
    assert len(data.encode()) <= 64 and data.startswith(f"a1:{ev['event_id']}:") and len(data.split(":")[2]) == 24
    assert TOKEN not in data and box.ack_key not in data
    # Avisos informativos (advertencias) sin botón.
    _, warn = sent_with_ack(box, tg, code="SIZE-OVER-80PCT", severity="warning")
    assert warn["reply_markup"] is None
    r = box.record(warn["text"].splitlines()[0][4:])
    assert r["requires_ack"] is False and r["state"] == "api_accepted"


def test_valid_ack_is_persisted_audited_and_confirmed(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    ev, msg = sent_with_ack(box, tg)
    assert box.record(ev["event_id"])["state"] == "api_accepted"
    upd = tg.press(msg)
    proc = box.poll()
    assert proc.returncode == 0 and json.loads(proc.stdout)["ack_poll"]["accepted"] == 1, proc.stderr
    rec = box.record(ev["event_id"])
    assert rec["state"] == "human_acknowledged" and rec["ack"]["late"] is False
    assert rec["ack"]["message_id"] == msg["message_id"] and rec["ack"]["update_id"] == upd["update_id"]
    assert len(rec["ack"]["actor_ref"]) == 16
    assert json.loads((box.state_dir / "cursor.json").read_text())["offset"] == upd["update_id"] + 1
    (answer,) = tg.calls("answerCallbackQuery")
    assert answer["callback_query_id"] == upd["callback_query"]["id"] and answer["text"] == "Recepción confirmada"
    (edit,) = tg.calls("editMessageReplyMarkup")
    assert edit["message_id"] == msg["message_id"] and edit["reply_markup"] == {"inline_keyboard": []}
    assert [e["kind"] for e in box.audit()].count("ack_accepted") == 1
    assert box.cli("--status").returncode == 0
    getupd = tg.calls("getUpdates")[0]
    assert getupd["allowed_updates"] == ["callback_query"]
    no_secrets(proc.stdout, proc.stderr, box.all_state_text())


def forged(box: Box, eid: str, key_hex: str | None = None) -> str:
    key = bytes.fromhex(key_hex or box.ack_key)
    return f"a1:{eid}:" + hmac.new(key, b"mainspot-alert-ack|v1|" + eid.encode(), hashlib.sha256).hexdigest()[:24]


@pytest.mark.parametrize("attack", ["foreign-actor", "bot-actor", "other-chat", "tampered-tag", "swapped-event",
                                    "token-as-key", "wrong-message", "wrong-date", "unknown-event", "no-ack-event",
                                    "malformed-data", "long-data", "no-message", "inline-message"])
def test_invalid_acks_never_change_state(tmp_path, tg, attack):
    box = Box(tmp_path, tg)
    box.enable_ack()
    ev, msg = sent_with_ack(box, tg)
    _, other = sent_with_ack(box, tg)
    data = msg["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
    kw: dict = {}
    if attack == "foreign-actor":
        kw = {"from_id": int(CHAT) + 7}
    elif attack == "bot-actor":
        kw = {"is_bot": True}
    elif attack == "other-chat":
        kw = {"chat_id": int(CHAT) + 7}
    elif attack == "tampered-tag":
        kw = {"data": data[:-1] + ("0" if data[-1] != "0" else "1")}
    elif attack == "swapped-event":
        kw = {"data": f"a1:{other['text'].splitlines()[0][4:]}:{data.split(':')[2]}"}
    elif attack == "token-as-key":
        kw = {"data": f"a1:{ev['event_id']}:" + hmac.new(TOKEN.encode(), b"mainspot-alert-ack|v1|" + ev["event_id"].encode(),
                                                        hashlib.sha256).hexdigest()[:24]}
    elif attack == "wrong-message":
        kw = {"message_id": other["message_id"]}      # firma válida del evento, pero otro mensaje
    elif attack == "wrong-date":
        kw = {"date": msg["date"] - 60}
    elif attack == "unknown-event":
        kw = {"data": forged(box, secrets.token_hex(16))}
    elif attack == "no-ack-event":
        wev, wmsg = sent_with_ack(box, tg, code="SIZE-OVER-80PCT", severity="warning")
        kw = {"data": forged(box, wev["event_id"]), "message_id": wmsg["message_id"], "date": wmsg["date"]}
    elif attack == "malformed-data":
        kw = {"data": "a1:../../etc/passwd:" + "0" * 24}
    elif attack == "long-data":
        kw = {"data": data + "x" * 40}
    elif attack in ("no-message", "inline-message"):
        kw = {"drop": ("message",)}
    upd = tg.press(msg, **kw)
    if attack == "inline-message":
        upd["callback_query"]["inline_message_id"] = "lab-inline"
    before = {e: box.record(e) for e in (ev["event_id"],)}
    proc = box.poll()
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["ack_poll"] == {"accepted": 0, "duplicate": 0, "rejected": 1, "ignored": 0}
    for eid, rec in before.items():
        assert box.record(eid) == rec                       # sin transición ni mutación
    (rej,) = [e for e in box.audit() if e["kind"] == "ack_rejected"]
    assert rej["update_id"] == upd["update_id"]
    assert json.loads((box.state_dir / "cursor.json").read_text())["offset"] == upd["update_id"] + 1
    assert [a["text"] for a in tg.calls("answerCallbackQuery")] == ["No se pudo validar el acuse"]
    assert tg.calls("editMessageReplyMarkup") == []
    no_secrets(proc.stdout, proc.stderr, box.all_state_text())


def test_double_click_replay_and_redelivery_are_idempotent(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    ev, msg = sent_with_ack(box, tg)
    u1 = tg.press(msg, update_id=500)
    tg.press(msg, update_id=501)                       # doble clic
    assert box.poll().returncode == 0
    # Caída entre persistir el acuse y avanzar el cursor: Telegram vuelve a entregar los mismos updates.
    cursor = box.state_dir / "cursor.json"
    cursor.write_text(json.dumps({"offset": u1["update_id"], "last_poll_ts": None}))
    tg.press(msg, update_id=500)                       # redelivery del mismo update
    proc = box.poll()
    assert proc.returncode == 0, proc.stderr
    rec = box.record(ev["event_id"])
    assert rec["state"] == "human_acknowledged" and rec["ack"]["update_id"] == 500
    assert [h["to"] for h in rec["history"]].count("human_acknowledged") == 1
    kinds = [e["kind"] for e in box.audit()]
    assert kinds.count("ack_accepted") == 1 and kinds.count("ack_duplicate") >= 2
    assert all(a["text"] in ("Recepción confirmada", "Recepción ya confirmada") for a in tg.calls("answerCallbackQuery"))


def test_ui_failure_does_not_affect_persisted_ack(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    ev, msg = sent_with_ack(box, tg)
    tg.ui_mode = "500"
    tg.press(msg)
    assert box.poll().returncode == 0
    assert box.record(ev["event_id"])["state"] == "human_acknowledged"


def test_single_consumer_webhook_and_conflict(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    _, msg = sent_with_ack(box, tg)
    tg.press(msg)
    fd = os.open(box.state_dir / "poller.lock", os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        proc = box.poll()
        assert proc.returncode == 17 and "another-consumer" in proc.stderr and tg.calls("getUpdates") == []
    finally:
        os.close(fd)
    tg.webhook_url = "https://attacker.example/hook"
    proc = box.poll()
    assert proc.returncode == 17 and "webhook-configured" in proc.stderr and tg.calls("getUpdates") == []
    tg.webhook_url, tg.updates_mode = "", "409"
    proc = box.poll()
    assert proc.returncode == 17 and "getupdates-conflict" in proc.stderr
    assert [e for e in box.audit() if e["kind"].startswith("ack_")] == []
    no_secrets(proc.stdout, proc.stderr)


def test_ack_poll_requires_ack_configuration(tmp_path, tg):
    box = Box(tmp_path, tg)
    proc = box.poll()
    assert proc.returncode == 11 and "ack-not-configured" in proc.stderr and tg.requests == []


def test_uncertain_acceptance_is_recovered_by_authentic_callback(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    ev = event()
    tg.mode = "drop-after-send"
    assert box.run_adapter(ev).returncode == 15
    (msg,) = tg.sent                                   # el mensaje existe aunque no hubo recibo
    assert box.record(ev["event_id"])["state"] == "api_acceptance_uncertain"
    tg.press(msg)
    assert box.poll().returncode == 0
    rec = box.record(ev["event_id"])
    assert rec["state"] == "human_acknowledged"
    assert rec["receipts"] == [{"message_id": msg["message_id"], "date": msg["date"], "kind": "recovered",
                                "recorded_ts": rec["receipts"][0]["recorded_ts"]}]


# --- vencimiento y recordatorios (API-0008), reloj simulado ---------------------------------

def test_f01_case_api_accepted_without_callback_is_not_acknowledged_and_goes_overdue(tmp_path, tg):
    """Caso F-01: Telegram aceptó (message_id válido) y nadie pulsó el botón."""
    box = Box(tmp_path, tg)
    box.enable_ack(deadline=600, interval=300, max_reminders=2)
    ev, msg = sent_with_ack(box, tg)
    t0 = time.time()
    st = box.cli("--status", now=t0)
    assert st.returncode == 18 and json.loads(st.stdout)["ack_processor"]["stale"] is True   # nadie procesa acuses
    assert box.poll(now=t0).returncode == 0                                                 # consumidor sin updates
    st = json.loads(box.cli("--status", now=t0).stdout)
    assert st["attention"] is False and st["unacknowledged"][0]["state"] == "api_accepted"
    rec = box.record(ev["event_id"])
    assert rec["receipts"][0]["message_id"] == msg["message_id"] and rec["ack"] is None
    over = box.cli("--check-overdue", now=t0 + 601)
    assert over.returncode == 18, over.stderr
    rec = box.record(ev["event_id"])
    assert rec["state"] == "ack_overdue" and rec["ack"] is None and rec["reminders_sent"] == 1
    assert json.loads(box.run_adapter(ev).stdout.splitlines()[0])["receipt"]["human_acknowledged"] is False
    assert len(tg.sent) == 2                                          # original + recordatorio 1 (sin reenvío)


def test_bounded_reminders_then_operator_attention_then_late_ack(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack(deadline=600, interval=300, max_reminders=2)
    ev, msg = sent_with_ack(box, tg)
    t0 = time.time()
    assert box.poll(now=t0).returncode == 0                                                # consumidor activo
    assert box.cli("--check-overdue", now=t0 + 100).returncode == 0 and len(tg.sent) == 1   # antes del plazo
    assert box.cli("--check-overdue", now=t0 + 601).returncode == 18 and len(tg.sent) == 2
    assert box.cli("--check-overdue", now=t0 + 700).returncode == 18 and len(tg.sent) == 2  # dentro del intervalo
    assert box.cli("--check-overdue", now=t0 + 902).returncode == 18 and len(tg.sent) == 3
    for k in range(5):                                                                     # agotados: sin más mensajes
        assert box.cli("--check-overdue", now=t0 + 1203 + 400 * k).returncode == 18
    assert len(tg.sent) == 3
    rec = box.record(ev["event_id"])
    assert rec["state"] == "needs_operator_attention" and rec["reminders_sent"] == 2
    rem = tg.sent[1:]
    assert [m["text"].splitlines()[:2] for m in rem] == [[f"ID: {ev['event_id']}", f"RECORDATORIO {n}/2 · aviso sin acuse de recepción"] for n in (1, 2)]
    assert all(m["reply_markup"] == msg["reply_markup"] for m in rem)
    assert [r["kind"] for r in rec["receipts"]] == ["initial", "reminder", "reminder"]
    tg.press(rem[1])                                                                         # acuse tardío sobre el recordatorio
    assert box.poll(now=t0 + 3000).returncode == 0
    rec = box.record(ev["event_id"])
    assert rec["state"] == "acknowledged_late" and rec["ack"]["late"] is True
    assert [h["to"] for h in rec["history"]][-3:] == ["ack_overdue", "needs_operator_attention", "acknowledged_late"]
    assert box.cli("--status", now=t0 + 3000).returncode == 0


def test_late_ack_without_overdue_check_keeps_the_violation(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack(deadline=600)
    ev, msg = sent_with_ack(box, tg)
    tg.press(msg)
    assert box.poll(now=time.time() + 601).returncode == 0
    rec = box.record(ev["event_id"])
    assert rec["state"] == "acknowledged_late"
    assert [(h["to"], h["reason"]) for h in rec["history"][-2:]] == [
        ("ack_overdue", "deadline_passed_detected_at_ack"), ("acknowledged_late", "human_ack")]


def test_send_failed_is_never_ack_overdue(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack()
    ev = event()
    tg.mode = "500"
    assert box.run_adapter(ev).returncode == 13
    tg.requests = []
    over = box.cli("--check-overdue", now=time.time() + 10 ** 6)
    assert over.returncode == 18 and box.record(ev["event_id"])["state"] == "send_failed"
    assert tg.calls("sendMessage") == []


def test_expired_updates_lose_the_ack_and_the_alert_goes_overdue(tmp_path, tg):
    """Telegram conserva updates 24 h (TR-0001): si caducan antes de consultarlos, el acuse no existe."""
    box = Box(tmp_path, tg)
    box.enable_ack(deadline=600)
    ev, msg = sent_with_ack(box, tg)
    tg.press(msg)
    tg.updates.clear()                                  # caducados en Telegram
    t0 = time.time()
    assert box.poll(now=t0).returncode == 0
    assert box.cli("--check-overdue", now=t0 + 601).returncode == 18
    assert box.record(ev["event_id"])["state"] == "ack_overdue"


def test_reminders_are_capped_per_run_and_overdue_check_is_single(tmp_path, tg):
    box = Box(tmp_path, tg)
    box.enable_ack(deadline=600, max_reminders=3)
    for _ in range(7):
        sent_with_ack(box, tg)
    assert len(tg.sent) == 7
    assert box.cli("--check-overdue", now=time.time() + 601).returncode == 18
    assert len(tg.sent) == 7 + 5                        # tope global por ejecución
    fd = os.open(box.state_dir / "overdue.lock", os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        assert box.cli("--check-overdue", now=time.time() + 2000).returncode == 17
    finally:
        os.close(fd)


# --- flujo del productor -------------------------------------------------------------------

class ProducerBox(Box):
    def __init__(self, root: Path, tg: FakeTelegram, s3: FakeS3Denied):
        super().__init__(root, tg)
        self.backups = root / "backups"
        self.backups.mkdir(mode=0o700)
        self.key = root / "backup.key"
        self.key.write_text(subprocess.run(["openssl", "rand", "-base64", "48"], check=True, capture_output=True,
                                           text=True).stdout)
        self.key.chmod(0o600)
        self.config = root / "remote.env"
        self.endpoint = s3.endpoint
        self.write_producer_config()

    def write_producer_config(self, **extra):
        values = {"MAINSPOT_REMOTE_BACKUP_ENABLED": "1", "S3_ENDPOINT": self.endpoint, "S3_REGION": "garage",
                  "S3_BUCKET": "mainspot-backups", "DEPLOYMENT_ID": "lab-alerts", "DATABASE": "mainspot",
                  "AWS_ACCESS_KEY_ID": "GKlab", "AWS_SECRET_ACCESS_KEY": "lab-secret-not-real",
                  "MAINSPOT_REMOTE_ALERT_COMMAND": str(self.adapter),
                  "MAINSPOT_REMOTE_ALERT_COMMAND_SHA256": hashlib.sha256(self.adapter.read_bytes()).hexdigest(), **extra}
        self.config.write_text("".join(f"{k}={v}\n" for k, v in values.items() if v is not None))
        self.config.chmod(0o600)

    def make_backup(self) -> str:
        bid = time.strftime("mainspot-db-%Y%m%dT%H%M%SZ", time.gmtime())
        p = self.backups / f"{bid}.dump.enc"
        with open(p, "wb") as out:
            subprocess.run(["openssl", "enc", "-e", *ENC_ARGS, "-salt", "-pass", f"file:{self.key}"],
                           input=b"PGDMP-synthetic-" + os.urandom(2048), stdout=out, check=True)
        sha = subprocess.run(["sha256sum", p.name], cwd=self.backups, check=True, capture_output=True, text=True).stdout
        Path(f"{p}.sha256").write_text(sha)
        return bid

    def run(self, limit: int = 1):
        env = {"PATH": os.environ["PATH"], "HOME": str(self.home), "PYTHONPYCACHEPREFIX": "/tmp/omp-pyc",
               "MAINSPOT_REMOTE_CONFIG": str(self.config), "MAINSPOT_BACKUP_DIR": str(self.backups),
               "MAINSPOT_BACKUP_KEY": str(self.key), "MAINSPOT_REMOTE_LAB_MAX_BACKUP_BYTES": str(limit),
               "PYTHONUSERBASE": subprocess.run([sys.executable, "-m", "site", "--user-base"], capture_output=True,
                                                text=True).stdout.strip()}
        return subprocess.run([sys.executable, str(PRODUCER), "--lab-allow-http"], env=env, capture_output=True,
                              text=True, timeout=300)


def alert_lines(proc) -> list[str]:
    return [ln for ln in proc.stdout.splitlines() if "status=ALERT" in ln]


def test_size_limit_alert_delivered_in_the_same_run_independent_of_s3(tmp_path, tg, s3):
    box = ProducerBox(tmp_path, tg, s3)
    bid = box.make_backup()
    proc = box.run()
    lines = alert_lines(proc)
    size = [ln for ln in lines if "error=E-SIZE-LIMIT" in ln]
    assert len(size) == 1 and "delivery=ok" in size[0] and "pending=" not in size[0], proc.stdout
    sent_ids = {m["message_id"] for m in tg.sent}
    assert int(size[0].split("message_id=")[1].split()[0]) in sent_ids and "ack=" in size[0]
    assert "human_acknowledged" not in proc.stdout
    assert any("error=E-AUTH-DENIED" in ln and "delivery=ok" in ln for ln in lines)  # aviso de §13 de la ejecución
    texts = [b["text"] for _, b in tg.requests]
    assert any("E-SIZE-LIMIT" in t and bid in t for t in texts) and any("E-AUTH-DENIED" in t for t in texts)
    assert proc.stdout.index("error=E-SIZE-LIMIT") < proc.stdout.index("status=FAIL error=E-AUTH-DENIED")
    assert not (box.backups / "remote-alerts-pending").exists() or not list((box.backups / "remote-alerts-pending").iterdir())
    no_secrets(proc.stdout, proc.stderr, (box.backups / "backup-remote.log").read_text(),
               (box.backups / "remote-alerts.jsonl").read_text())


def test_unavailable_channel_keeps_event_and_retries_once_per_run_without_duplicates(tmp_path, tg, s3):
    box = ProducerBox(tmp_path, tg, s3)
    box.make_backup()
    tg.mode = "500"
    proc = box.run()
    size = [ln for ln in alert_lines(proc) if "error=E-SIZE-LIMIT" in ln][0]
    assert "delivery=failed-unavailable" in size and "pending=yes" in size
    pending = list((box.backups / "remote-alerts-pending").glob("*.json"))
    assert len(pending) == 2 and all(oct(p.stat().st_mode & 0o777) == "0o600" for p in pending)  # E-SIZE-LIMIT y E-AUTH-DENIED
    # Siguiente ejecución con Telegram disponible: se entregan los pendientes; no hay avisos nuevos duplicados.
    tg.mode, tg.requests = "ok", []
    proc = box.run()
    retried = [ln for ln in alert_lines(proc) if "retry=yes" in ln]
    assert len(retried) == 2 and all("delivery=ok" in ln for ln in retried), proc.stdout
    assert not [ln for ln in alert_lines(proc) if "retry=yes" not in ln]  # E-SIZE-LIMIT (marca) y E-AUTH-DENIED (24 h) suprimidos
    assert len(tg.requests) == 2 and list((box.backups / "remote-alerts-pending").glob("*.json")) == []


def test_pending_retries_are_bounded_and_abandoned(tmp_path, tg, s3):
    box = ProducerBox(tmp_path, tg, s3)
    box.make_backup()
    tg.mode = "500"
    box.run()
    for p in (box.backups / "remote-alerts-pending").glob("*.json"):
        rec = json.loads(p.read_text())
        rec["attempts"] = 24
        p.write_text(json.dumps(rec))
    tg.mode, tg.requests = "ok", []
    proc = box.run()
    assert len([ln for ln in alert_lines(proc) if "delivery=abandoned" in ln]) == 2
    assert tg.requests == [] and len(list((box.backups / "remote-alerts-failed").glob("*.json"))) == 2


def test_circuit_breaker_limits_retries_while_channel_is_down(tmp_path, tg, s3):
    box = ProducerBox(tmp_path, tg, s3)
    box.make_backup()
    tg.mode = "500"
    box.run()
    tg.requests = []
    proc = box.run()  # sigue caído: el primer pendiente falla y los demás esperan a la siguiente ejecución
    assert len([ln for ln in alert_lines(proc) if "retry=yes" in ln]) == 1 and len(tg.requests) == 2  # 1 evento × 2 intentos


def test_not_configured_and_failed_delivery_are_distinguished(tmp_path, tg, s3):
    box = ProducerBox(tmp_path, tg, s3)
    box.make_backup()
    box.write_producer_config(MAINSPOT_REMOTE_ALERT_COMMAND=None, MAINSPOT_REMOTE_ALERT_COMMAND_SHA256=None)
    proc = box.run()
    assert all("delivery=not-configured" in ln for ln in alert_lines(proc)) and alert_lines(proc)
    assert not (box.backups / "remote-alerts-pending").exists()
    box.write_producer_config()
    box.cfg.unlink()  # adaptador instalado pero sin credenciales
    shutil.rmtree(box.backups / ".remote-size-rejected", ignore_errors=True)
    (box.backups / "remote-alerts-state.json").unlink()
    proc = box.run()
    assert any("delivery=failed-not-configured" in ln and "pending=yes" in ln for ln in alert_lines(proc))


@pytest.mark.parametrize("case", ["sha-mismatch", "sha-missing", "group-writable-dir", "symlink", "relative",
                                  "with-arguments", "world-writable-file"])
def test_untrusted_alert_command_fails_safe_before_any_network(tmp_path, tg, s3, case):
    box = ProducerBox(tmp_path, tg, s3)
    box.make_backup()
    if case == "sha-mismatch":
        box.write_producer_config(MAINSPOT_REMOTE_ALERT_COMMAND_SHA256="0" * 64)
    elif case == "sha-missing":
        box.write_producer_config(MAINSPOT_REMOTE_ALERT_COMMAND_SHA256=None)
    elif case == "group-writable-dir":
        box.adapter.parent.chmod(0o770)
    elif case == "symlink":
        link = box.root / "libexec" / "link.py"
        link.symlink_to(box.adapter)
        box.write_producer_config(MAINSPOT_REMOTE_ALERT_COMMAND=str(link))
    elif case == "relative":
        box.write_producer_config(MAINSPOT_REMOTE_ALERT_COMMAND="libexec/remote-alert-telegram.py")
    elif case == "with-arguments":
        box.write_producer_config(MAINSPOT_REMOTE_ALERT_COMMAND="/bin/sh -c touch PWNED")
    elif case == "world-writable-file":
        box.adapter.chmod(0o702)
    proc = box.run()
    assert proc.returncode == 1 and "status=FAIL error=E-CONFIG" in proc.stdout, proc.stdout
    assert "MAINSPOT_REMOTE_ALERT_COMMAND" in proc.stdout and tg.requests == []
    assert not list(tmp_path.rglob("PWNED")) and not (Path.cwd() / "PWNED").exists()


@pytest.mark.parametrize("mode", ["no-message-id", "other-chat", "drop-after-send"])
def test_uncertain_or_misrouted_delivery_is_not_success_nor_resent(tmp_path, tg, s3, mode):
    box = ProducerBox(tmp_path, tg, s3)
    box.make_backup()
    tg.mode = mode
    proc = box.run()
    expected = {"no-message-id": "failed-acceptance-uncertain", "other-chat": "failed-misrouted",
                "drop-after-send": "failed-acceptance-uncertain"}[mode]
    lines = alert_lines(proc)
    assert lines and all(f"delivery={expected}" in ln and "needs_operator_attention=yes" in ln for ln in lines), proc.stdout
    assert all("delivery=ok" not in ln and "pending=yes" not in ln for ln in lines)
    assert not list((box.backups / "remote-alerts-pending").glob("*.json"))
    failed = list((box.backups / "remote-alerts-failed").glob("*.json"))
    assert len(failed) == len(lines) and all(json.loads(f.read_text())["needs_operator_attention"] for f in failed)
    sent = len(tg.calls("sendMessage"))
    tg.mode = "ok"
    box.run()                                            # sin reenvío de los eventos inciertos
    assert len(tg.calls("sendMessage")) == sent
    no_secrets(proc.stdout, proc.stderr, (box.backups / "backup-remote.log").read_text())
