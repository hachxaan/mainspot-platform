"""Pruebas del adaptador de avisos por Telegram (DEC-0064/DEC-0065) y del flujo de avisos del productor.

Sin red externa ni Garage: un Telegram falso por HTTPS en 127.0.0.1 (certificado autofirmado generado
aquí y confiado solo con TELEGRAM_CA_FILE) y un «S3» falso que responde 403 a todo, para que el productor
termine en segundos. Token y chat son sintéticos y desechables.

    PYTHONPYCACHEPREFIX=/tmp/omp-pyc python3 -m pytest -p no:cacheprovider -v tests/ops/backup-remote/test_alert_telegram.py
"""
from __future__ import annotations

import hashlib
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

class FakeTelegram:
    def __init__(self, certdir: Path):
        self.mode = "ok"            # ok | 401 | 400 | 500 | hang | 429-short | 429-long
        self.requests: list[tuple[str, dict]] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                fake.requests.append((self.path, body))
                mode = fake.mode
                if mode == "hang":
                    time.sleep(12)
                    return
                if mode == "429-short" and len(fake.requests) == 1:
                    status, payload = 429, {"ok": False, "parameters": {"retry_after": 1}}
                elif mode == "429-long":
                    status, payload = 429, {"ok": False, "parameters": {"retry_after": 60}}
                elif mode in ("401", "400", "500"):
                    status, payload = int(mode), {"ok": False, "description": "lab"}
                else:
                    status, payload = 200, {"ok": True, "result": {"message_id": len(fake.requests)}}
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

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
        self.root = root
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


def event(**over) -> dict:
    ev = {"ts": "2026-10-24T21:00:00Z", "producer": "db-backup-remote", "event_id": secrets.token_hex(16),
          "code": "E-SIZE-LIMIT", "severity": "error", "backup_id": "mainspot-db-20261024T210000Z",
          "size_bytes": 10, "manifest_bytes": 2, "total_bytes": 12, "limit_bytes": 11,
          "action": "not-uploaded-local-backup-kept"}
    ev.update(over)
    return {k: v for k, v in ev.items() if v is not None}


def no_secrets(*blobs: str | bytes) -> None:
    joined = "\n".join(b.decode() if isinstance(b, bytes) else b for b in blobs)
    for s in SECRETS:
        assert s not in joined


# --- adaptador -----------------------------------------------------------------------------

def test_delivery_ok_plain_text_over_https(tmp_path, tg):
    box = Box(tmp_path, tg)
    ev = event()
    proc = box.run_adapter(ev)
    assert proc.returncode == 0, proc.stderr
    ((path, body),) = tg.requests
    assert path == f"/bot{TOKEN}/sendMessage" and body["chat_id"] == CHAT and "parse_mode" not in body
    for needle in ("E-SIZE-LIMIT", ev["backup_id"], "12 B (límite 11 B)", ev["event_id"], "2026-10-24T21:00:00Z"):
        assert needle in body["text"]
    no_secrets(body["text"], proc.stdout, proc.stderr)


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


def test_provider_error_retries_once_then_unavailable(tmp_path, tg):
    box = Box(tmp_path, tg)
    tg.mode = "500"
    proc = box.run_adapter(event())
    assert proc.returncode == 13 and len(tg.requests) == 2
    no_secrets(proc.stdout, proc.stderr)


def test_timeout_is_bounded(tmp_path, tg):
    box = Box(tmp_path, tg)
    tg.mode = "hang"
    t0 = time.monotonic()
    proc = box.run_adapter(event())
    assert proc.returncode == 13 and time.monotonic() - t0 < 25 and len(tg.requests) == 2


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


def test_synthetic_test_mode_sends_a_test_event_only(tmp_path, tg):
    box = Box(tmp_path, tg)
    proc = subprocess.run([str(box.adapter), "--synthetic-test"], capture_output=True, text=True, timeout=60,
                          env={"PATH": "/usr/bin:/bin", "HOME": str(box.home)})
    assert proc.returncode == 0 and "TEST-SYNTHETIC" in proc.stdout
    ((_, body),) = tg.requests
    assert "Código: TEST-SYNTHETIC" in body["text"] and "INFO" in body["text"]
    no_secrets(proc.stdout, proc.stderr, body["text"])
    bad = subprocess.run([str(box.adapter), "--anything"], capture_output=True, timeout=30,
                         env={"PATH": "/usr/bin:/bin", "HOME": str(box.home)})
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
