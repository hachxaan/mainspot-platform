"""Pruebas del productor remoto `scripts/ops/backup/db-backup-remote.py` contra un
Garage de laboratorio (contrato mainspot-backup-object-storage v1).

- Garage oficial `dxflrs/garage:v2.4.1` en Docker, solo 127.0.0.1, contenedor
  `msp-garage-lab-producer-<aleatorio>`, sin volúmenes en el host; se destruye al
  terminar (`docker rm -f -v`). Si Docker no está disponible, la suite se omite.
- Respaldos sintéticos: texto en claro sintético cifrado con el comando exacto de
  §4.2 y una clave desechable (`openssl rand -base64 48`). No hace falta pg_dump.
- HOME, la clave, la configuración y el directorio de respaldos son temporales: la
  suite nunca lee `~/.config/mainspot` ni `.env`.

Ejecutar:
    PYTHONPYCACHEPREFIX=/tmp/omp-pyc python3 -m pytest -p no:cacheprovider -v tests/ops/backup-remote
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import http.client
import http.server
import importlib.util
import json
import os
import re
import secrets
import shutil
import site
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[3]
PRODUCER = REPO / "scripts" / "ops" / "backup" / "db-backup-remote.py"
MANIFEST_TOOL = REPO / "docs" / "contracts" / "backup-object-storage" / "v1" / "reference" / "manifest_tool.py"
GARAGE_IMAGE = "dxflrs/garage:v2.4.1"
BUCKET = "mainspot-backups"
LAB_PREFIX = "msp-garage-lab-producer-"

boto3 = pytest.importorskip("boto3")
from botocore.config import Config  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

LIFECYCLE_V1 = {"Rules": [
    {"ID": "mainspot-backups-v1-retention-14d", "Status": "Enabled", "Filter": {"Prefix": "v1/"},
     "Expiration": {"Days": 14}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
    {"ID": "mainspot-backups-conformance-1d", "Status": "Enabled", "Filter": {"Prefix": "_conformance/"},
     "Expiration": {"Days": 1}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
]}

ALL_OUTPUT: list[str] = []  # stdout+stderr de cada ejecución del productor, para la prueba de secretos
SECRETS: set[str] = set()   # secretos desechables que nunca deben aparecer en salidas ni registros


def _load_manifest_tool():
    spec = importlib.util.spec_from_file_location("manifest_tool", MANIFEST_TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mt = _load_manifest_tool()


def docker_ok() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


pytestmark = pytest.mark.skipif(not docker_ok(), reason="Docker no disponible: no se puede levantar el Garage de laboratorio")


# --- laboratorio Garage ------------------------------------------------------------

class GarageLab:
    def __init__(self, workdir: Path):
        self.name = LAB_PREFIX + secrets.token_hex(4)
        self.workdir = workdir
        self.port = 0
        self.writer: tuple[str, str] = ("", "")
        self.reader: tuple[str, str] = ("", "")

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def garage(self, *args: str) -> str:
        out = subprocess.run(["docker", "exec", self.name, "/garage", *args], capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise RuntimeError(f"garage {' '.join(args)} falló: {out.stderr[-400:]}")
        return out.stdout

    def start(self) -> None:
        cfg = self.workdir / "garage.toml"
        cfg.write_text(
            'metadata_dir = "/var/lib/garage/meta"\ndata_dir = "/var/lib/garage/data"\n'
            'db_engine = "sqlite"\nreplication_factor = 1\n'
            'rpc_bind_addr = "[::]:3901"\nrpc_public_addr = "127.0.0.1:3901"\n'
            f'rpc_secret = "{secrets.token_hex(32)}"\n'
            '[s3_api]\ns3_region = "garage"\napi_bind_addr = "[::]:3900"\n'
            f'[admin]\napi_bind_addr = "[::]:3903"\nadmin_token = "{secrets.token_hex(16)}"\n')
        subprocess.run(["docker", "run", "-d", "--name", self.name, "-p", "127.0.0.1::3900",
                        "-v", f"{cfg}:/etc/garage.toml:ro", GARAGE_IMAGE], check=True, capture_output=True, timeout=120)
        port = subprocess.run(["docker", "port", self.name, "3900"], check=True, capture_output=True, text=True).stdout
        self.port = int(port.strip().rsplit(":", 1)[1])
        node = None
        for _ in range(60):
            try:
                m = re.search(r"^([0-9a-f]{16})\s", self.garage("status"), re.M)
            except RuntimeError:
                m = None
            if m:
                node = m.group(1)
                break
            time.sleep(0.5)
        assert node, "el nodo Garage no arrancó"
        self.garage("layout", "assign", "-z", "lab", "-c", "1G", node)
        self.garage("layout", "apply", "--version", "1")
        self.garage("bucket", "create", BUCKET)
        self.writer = self._create_key("writer", "--read", "--write")
        self.reader = self._create_key("reader", "--read")
        for _ in range(40):  # la API S3 tarda un instante en aceptar el layout
            try:
                self.client(self.writer).head_bucket(Bucket=BUCKET)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        self.client(self.writer).put_bucket_lifecycle_configuration(Bucket=BUCKET, LifecycleConfiguration=LIFECYCLE_V1)

    def _create_key(self, name: str, *perms: str) -> tuple[str, str]:
        out = self.garage("key", "create", name)
        kid = re.search(r"^Key ID:\s+(\S+)", out, re.M).group(1)
        sec = re.search(r"^Secret key:\s+(\S+)", out, re.M).group(1)
        self.garage("bucket", "allow", *perms, BUCKET, "--key", name)
        SECRETS.add(sec)
        SECRETS.add(kid)
        return kid, sec

    def client(self, creds: tuple[str, str], endpoint: str | None = None):
        return boto3.client("s3", endpoint_url=endpoint or self.endpoint, region_name="garage",
                            aws_access_key_id=creds[0], aws_secret_access_key=creds[1],
                            config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                                          retries={"max_attempts": 1}, request_checksum_calculation="when_required",
                                          response_checksum_validation="when_required"))

    def stop(self) -> None:
        subprocess.run(["docker", "rm", "-f", "-v", self.name], capture_output=True, timeout=60)


@pytest.fixture(scope="module")
def lab(tmp_path_factory):
    lab = GarageLab(tmp_path_factory.mktemp("garage"))
    try:
        lab.start()
    except Exception:
        lab.stop()
        raise
    yield lab
    lab.stop()
    left = subprocess.run(["docker", "ps", "-a", "--filter", f"name={lab.name}", "--format", "{{.Names}}"],
                          capture_output=True, text=True).stdout.strip()
    assert left == "", f"contenedor de laboratorio no eliminado: {left}"


# --- proxy HTTP mínimo (fallos transitorios, reloj desviado, registro de cabeceras) ----

class Proxy:
    """Proxy inverso 127.0.0.1 → Garage. `fail(status, n, when)` responde n veces con ese
    código a las peticiones que cumplan `when(method, path)`; `date_offset_s` desplaza la
    cabecera Date de las respuestas; `log` guarda (método, ruta, cabeceras de petición, estado)."""

    def __init__(self, upstream_port: int):
        self.upstream_port = upstream_port
        self.failures: list[int] = []
        self.fail_when = lambda method, path: True
        self.date_offset_s = 0
        self.corruptions = 0
        self.corrupt_when = lambda method, path: True
        self.log: list[tuple[str, str, dict, int]] = []
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # silencio
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                req_headers = {k: v for k, v in self.headers.items()}
                if proxy.failures and proxy.fail_when(self.command, self.path):
                    status = proxy.failures.pop(0)
                    payload = (f"<?xml version='1.0'?><Error><Code>ServiceUnavailable</Code>"
                               f"<Message>lab-injected {status}</Message></Error>").encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/xml")
                    self.send_header("Content-Length", str(len(payload)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(payload)
                    proxy.log.append((self.command, self.path, req_headers, status))
                    self.close_connection = True
                    return
                if body and proxy.corruptions and proxy.corrupt_when(self.command, self.path):
                    proxy.corruptions -= 1
                    body = body[:-1] + bytes([body[-1] ^ 0x01])  # un byte alterado en tránsito (Content-MD5 ya no coincide)
                fwd = {k: v for k, v in self.headers.items() if k.lower() not in ("connection", "expect")}
                conn = http.client.HTTPConnection("127.0.0.1", proxy.upstream_port, timeout=120)
                conn.request(self.command, self.path, body=body, headers=fwd)
                resp = conn.getresponse()
                data = resp.read()
                self.send_response_only(resp.status, resp.reason)
                for k, v in resp.getheaders():
                    kl = k.lower()
                    if kl in ("connection", "transfer-encoding", "content-length"):
                        continue
                    if kl == "date" and proxy.date_offset_s:
                        v = http.server.BaseHTTPRequestHandler.date_time_string(self, time.time() + proxy.date_offset_s)
                    self.send_header(k, v)
                if self.command != "HEAD" or not resp.getheader("Content-Length"):
                    self.send_header("Content-Length", str(len(data)))
                else:
                    self.send_header("Content-Length", resp.getheader("Content-Length"))
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)
                conn.close()
                proxy.log.append((self.command, self.path, req_headers, resp.status))
                self.close_connection = True

            do_GET = do_PUT = do_HEAD = do_POST = do_DELETE = _handle

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def fail(self, status: int, times: int, when=None) -> None:
        self.failures = [status] * times
        self.fail_when = when or (lambda method, path: True)

    def corrupt(self, times: int, when=None) -> None:
        self.corruptions = times
        self.corrupt_when = when or (lambda method, path: True)

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def proxy(lab):
    p = Proxy(lab.port)
    yield p
    p.stop()


# --- entorno por prueba: HOME, clave, respaldos y configuración desechables ----------

ENC_ARGS = ["-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-md", "sha256"]


class Env:
    counter = 0

    def __init__(self, root: Path, lab: GarageLab, creds: tuple[str, str], endpoint: str | None = None):
        Env.counter += 1
        self.root = root
        self.home = root / "home"
        self.backup_dir = root / "backups"
        self.key_file = root / "backup.key"
        self.config = root / "remote.env"
        self.deployment_id = f"lab-{Env.counter:02d}-{secrets.token_hex(2)}"
        self.database = "mainspot"
        self.lab = lab
        self.endpoint = endpoint or lab.endpoint
        self.creds = creds
        self.home.mkdir()
        self.backup_dir.mkdir(mode=0o700)
        passphrase = subprocess.run(["openssl", "rand", "-base64", "48"], check=True, capture_output=True, text=True).stdout
        self.key_file.write_text(passphrase)
        self.key_file.chmod(0o600)
        SECRETS.add(passphrase.strip())
        self.passphrase = mt.read_passphrase(str(self.key_file))
        self.write_config(enabled=True)

    def write_config(self, enabled: bool = True, **extra: str) -> None:
        lines = {
            "MAINSPOT_REMOTE_BACKUP_ENABLED": "1" if enabled else "0",
            "S3_ENDPOINT": self.endpoint, "S3_REGION": "garage", "S3_BUCKET": BUCKET,
            "DEPLOYMENT_ID": self.deployment_id, "DATABASE": self.database,
            "AWS_ACCESS_KEY_ID": self.creds[0], "AWS_SECRET_ACCESS_KEY": self.creds[1],
        }
        lines.update(extra)
        self.config.write_text("".join(f"{k}={v}\n" for k, v in lines.items()))
        self.config.chmod(0o600)

    def make_backup(self, backup_id: str, plaintext: bytes | None = None) -> Path:
        """Respaldo sintético: comando exacto de §4.2 sobre un texto en claro sintético + .sha256 (sha256sum)."""
        name = f"{backup_id}.dump.enc"
        path = self.backup_dir / name
        plaintext = plaintext if plaintext is not None else b"PGDMP-synthetic-" + os.urandom(4096)
        with open(path, "wb") as out:
            subprocess.run(["openssl", "enc", "-e", *ENC_ARGS, "-salt", "-pass", f"file:{self.key_file}"],
                           input=plaintext, stdout=out, check=True)
        path.chmod(0o600)
        sha = subprocess.run(["sha256sum", name], cwd=self.backup_dir, check=True, capture_output=True, text=True).stdout
        Path(str(path) + ".sha256").write_text(sha)
        Path(str(path) + ".sha256").chmod(0o600)
        assert path.read_bytes()[:8] == b"Salted__"
        return path

    def run(self, *args: str, extra_env: dict | None = None) -> subprocess.CompletedProcess:
        env = {"PATH": os.environ["PATH"], "HOME": str(self.home), "PYTHONPYCACHEPREFIX": "/tmp/omp-pyc",
               "MAINSPOT_REMOTE_CONFIG": str(self.config), "MAINSPOT_BACKUP_DIR": str(self.backup_dir),
               "MAINSPOT_BACKUP_KEY": str(self.key_file), "PYTHONUSERBASE": site.getuserbase()}
        if extra_env:
            env.update(extra_env)
        if "--lab-allow-http" not in args:
            args = (*args, "--lab-allow-http")
        proc = subprocess.run([sys.executable, str(PRODUCER), *args], env=env, capture_output=True, text=True, timeout=600)
        ALL_OUTPUT.append(proc.stdout + proc.stderr)
        return proc

    def log_text(self) -> str:
        p = self.backup_dir / "backup-remote.log"
        return p.read_text() if p.exists() else ""

    def keys(self, backup_id: str) -> tuple[str, str]:
        okey = mt.object_key(self.deployment_id, self.database, backup_id)
        return okey, mt.manifest_key(okey)

    def s3(self):
        return self.lab.client(self.lab.writer)


@pytest.fixture
def env(tmp_path, lab):
    return Env(tmp_path, lab, lab.writer)


def backup_id_at(when: dt.datetime) -> str:
    return f"mainspot-db-{when:%Y%m%dT%H%M%SZ}"


def now_id(delta: dt.timedelta = dt.timedelta(0)) -> str:
    return backup_id_at(dt.datetime.now(dt.timezone.utc) + delta)


def lines_for(proc: subprocess.CompletedProcess, backup_id: str) -> list[str]:
    return [ln for ln in proc.stdout.splitlines() if re.search(rf"(?:^| )backup_id={re.escape(backup_id)}(?: |$)", ln)]


def field(line: str, key: str) -> str:
    m = re.search(rf"(?:^| ){re.escape(key)}=(\S+)", line)
    assert m, f"{key} no está en: {line}"
    return m.group(1)


def head_or_none(s3, key: str):
    try:
        return s3.head_object(Bucket=BUCKET, Key=key, ChecksumMode="ENABLED")
    except ClientError as exc:
        if exc.response["ResponseMetadata"]["HTTPStatusCode"] == 404:
            return None
        raise

# --- pruebas -------------------------------------------------------------------------

def test_disabled_without_config(tmp_path, lab):
    env = Env(tmp_path, lab, lab.writer)
    env.config.unlink()
    proc = env.run()
    assert proc.returncode == 0, proc.stderr
    assert "status=DISABLED" in proc.stdout and "reason=no-config" in proc.stdout
    assert "status=DISABLED" in env.log_text()


def test_disabled_when_flag_is_not_1(tmp_path, lab):
    env = Env(tmp_path, lab, lab.writer, endpoint="https://127.0.0.1:9")  # puerto cerrado: no debe tocarse
    env.write_config(enabled=False)
    bid = now_id()
    env.make_backup(bid)
    proc = env.run()
    assert proc.returncode == 0, proc.stderr
    assert "status=DISABLED" in proc.stdout
    assert head_or_none(env.s3(), env.keys(bid)[0]) is None


def test_upload_complete_and_verified(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    local = env.make_backup(bid)
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "OK" and field(line, "action") == "uploaded"
    okey, mkey = env.keys(bid)
    assert field(line, "object_key") == okey
    size, sha = mt.file_digest(str(local))
    assert field(line, "size_bytes") == str(size) and field(line, "sha256") == sha
    s3 = env.s3()
    h = s3.head_object(Bucket=BUCKET, Key=okey, ChecksumMode="ENABLED")
    assert h["ContentLength"] == size
    assert h["ChecksumSHA256"] == base64.b64encode(bytes.fromhex(sha)).decode()
    assert h["Metadata"] == {"sha256": sha, "backup-id": bid}
    assert h["ContentType"] == "application/octet-stream"
    assert s3.get_object(Bucket=BUCKET, Key=okey)["Body"].read() == local.read_bytes()
    mh = s3.head_object(Bucket=BUCKET, Key=mkey)
    assert mh["ContentType"] == "application/json"
    manifest = json.loads(s3.get_object(Bucket=BUCKET, Key=mkey)["Body"].read())
    assert mt.verify(manifest, str(local), env.passphrase, mkey) == []
    assert manifest["encryption"]["key_id"] == mt.key_id(env.passphrase)
    # §8.4 / §6.3: cuerpo firmado, Content-MD5 y x-amz-checksum-sha256 en cabeceras; sin trailers ni chunked.
    puts = [(m, p, hd) for m, p, hd, st in proxy.log if m == "PUT"]
    assert len(puts) == 2
    for _, path, hd in puts:
        low = {k.lower(): v for k, v in hd.items()}
        assert "content-md5" in low and "x-amz-checksum-sha256" in low, path
        assert re.fullmatch(r"[0-9a-f]{64}", low.get("x-amz-content-sha256", "")), low.get("x-amz-content-sha256")
        assert "transfer-encoding" not in low and "x-amz-trailer" not in low
    assert any(m == "HEAD" and p.endswith(okey.rsplit("/", 1)[1]) and hd.get("x-amz-checksum-mode") == "ENABLED"
               for m, p, hd, st in proxy.log)
    # §10.1 tras subir: fresco y ciclo de vida correcto; aviso por cantidad (1 < 13).
    check = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
    assert len(check) == 1 and field(check[0], "status") == "OK" and field(check[0], "lifecycle") == "ok"
    assert field(check[0], "complete") == "1" and "complete-count-out-of-range" in field(check[0], "warnings")
    assert env.log_text().count("\n") == 2


def test_second_run_is_idempotent(env):
    bid = now_id()
    env.make_backup(bid)
    assert env.run().returncode == 0
    s3 = env.s3()
    okey, mkey = env.keys(bid)
    before = (s3.head_object(Bucket=BUCKET, Key=okey), s3.head_object(Bucket=BUCKET, Key=mkey))
    time.sleep(1.1)  # LastModified tiene resolución de segundos
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "OK" and field(line, "action") == "already-complete"
    after = (s3.head_object(Bucket=BUCKET, Key=okey), s3.head_object(Bucket=BUCKET, Key=mkey))
    for b, a in zip(before, after):
        assert (b["ETag"], b["LastModified"]) == (a["ETag"], a["LastModified"])


def test_remote_conflict_when_remote_differs(env):
    bid = now_id()
    env.make_backup(bid, plaintext=b"PGDMP-first")
    assert env.run().returncode == 0
    s3 = env.s3()
    okey, mkey = env.keys(bid)
    before = (s3.head_object(Bucket=BUCKET, Key=okey)["ETag"], s3.head_object(Bucket=BUCKET, Key=mkey)["ETag"])
    env.make_backup(bid, plaintext=b"PGDMP-second")  # mismo backup_id, otro contenido local
    time.sleep(1.1)
    proc = env.run()
    assert proc.returncode == 1
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-REMOTE-CONFLICT"
    after = (s3.head_object(Bucket=BUCKET, Key=okey)["ETag"], s3.head_object(Bucket=BUCKET, Key=mkey)["ETag"])
    assert before == after  # nada se tocó


def test_remote_conflict_when_manifest_exists_but_object_missing(env):
    bid = now_id()
    local = env.make_backup(bid)
    okey, mkey = env.keys(bid)
    size, sha = mt.file_digest(str(local))
    manifest = mt.build_manifest(passphrase=env.passphrase, size=size, sha256=sha, backup_id=bid,
                                 deployment_id=env.deployment_id, database=env.database)
    env.s3().put_object(Bucket=BUCKET, Key=mkey, Body=json.dumps(manifest).encode(), ContentType="application/json")
    proc = env.run()
    assert proc.returncode == 1
    (line,) = lines_for(proc, bid)
    assert field(line, "error") == "E-REMOTE-CONFLICT"
    assert head_or_none(env.s3(), okey) is None


def test_outside_window_is_skipped(env):
    old = now_id(dt.timedelta(hours=-25))
    fresh = now_id()
    env.make_backup(old)
    env.make_backup(fresh)
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (line,) = lines_for(proc, old)
    assert field(line, "status") == "SKIPPED" and field(line, "error") == "E-UPLOAD-WINDOW"
    assert head_or_none(env.s3(), env.keys(old)[0]) is None
    assert field(lines_for(proc, fresh)[0], "action") == "uploaded"
    # el respaldo de 23 h sí entra en la ventana
    recent = now_id(dt.timedelta(hours=-23))
    env.make_backup(recent)
    proc = env.run()
    assert proc.returncode == 0
    assert field(lines_for(proc, recent)[0], "action") == "uploaded"
    assert field(lines_for(proc, old)[0], "status") == "SKIPPED"


def test_incomplete_object_is_reuploaded(env):
    bid = now_id()
    local = env.make_backup(bid)
    okey, mkey = env.keys(bid)
    env.s3().put_object(Bucket=BUCKET, Key=okey, Body=b"Salted__garbage-from-an-interrupted-upload")
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert field(lines_for(proc, bid)[0], "action") == "uploaded"
    assert env.s3().get_object(Bucket=BUCKET, Key=okey)["Body"].read() == local.read_bytes()
    assert head_or_none(env.s3(), mkey) is not None


def test_local_integrity_failure(env):
    bid = now_id()
    local = env.make_backup(bid)
    sha_path = Path(str(local) + ".sha256")
    sha_path.write_text("0" * 64 + f"  {local.name}\n")
    proc = env.run()
    assert proc.returncode == 1
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-LOCAL-INTEGRITY"
    assert head_or_none(env.s3(), env.keys(bid)[0]) is None


def test_retries_transient_503_then_succeeds(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    env.make_backup(bid)
    proxy.fail(503, 2, when=lambda method, path: method == "PUT")
    t0 = time.monotonic()
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "OK" and field(line, "action") == "uploaded"
    assert field(line, "attempts") == "3"
    assert proxy.failures == []
    puts = [st for m, p, hd, st in proxy.log if m == "PUT" and p.endswith(".dump.enc")]
    assert puts[:3] == [503, 503, 200]
    assert time.monotonic() - t0 < 60  # backoff aleatorio acotado: <=4 s + <=8 s


def test_transient_failure_exhausts_after_5_attempts(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    env.make_backup(bid)
    proxy.fail(503, 5, when=lambda method, path: method == "PUT")
    proc = env.run()
    assert proc.returncode == 1
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-SERVER" and field(line, "attempts") == "5"
    assert head_or_none(env.s3(), env.keys(bid)[1]) is None  # sin manifiesto


def test_no_retry_on_403(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.reader, endpoint=proxy.endpoint)  # clave de solo lectura: PutObject → 403
    bid = now_id()
    env.make_backup(bid)
    proc = env.run()
    assert proc.returncode == 1
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-AUTH-DENIED" and field(line, "attempts") == "1"
    assert [st for m, p, hd, st in proxy.log if m == "PUT"] == [403]


def test_clock_skew_stops_before_any_upload(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    env.make_backup(bid)
    proxy.date_offset_s = 600
    proc = env.run()
    assert proc.returncode == 1
    assert "error=E-AUTH-SKEW" in proc.stdout and "skew_s=" in proc.stdout
    assert lines_for(proc, bid) == []
    assert all(m == "HEAD" for m, p, hd, st in proxy.log)
    assert head_or_none(env.s3(), env.keys(bid)[0]) is None
    proxy.date_offset_s = 200  # dentro de la tolerancia de 300 s
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_daily_check_lifecycle(env):
    s3 = env.s3()
    proc = env.run("--check-only")  # prefijo vacío: sin respaldo completo → E-FRESHNESS
    assert proc.returncode == 1
    (check,) = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
    assert field(check, "error") == "E-FRESHNESS" and field(check, "lifecycle") == "ok"
    bid = now_id()
    env.make_backup(bid)
    assert env.run().returncode == 0
    proc = env.run("--check-only")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (check,) = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
    assert field(check, "status") == "OK" and field(check, "complete") == "1" and field(check, "newest_backup_id") == bid
    assert lines_for(proc, bid) == []  # --check-only no procesa respaldos locales
    wrong = {"Rules": [dict(LIFECYCLE_V1["Rules"][0], Expiration={"Days": 30}), LIFECYCLE_V1["Rules"][1]]}
    s3.put_bucket_lifecycle_configuration(Bucket=BUCKET, LifecycleConfiguration=wrong)
    try:
        proc = env.run("--check-only")
        assert proc.returncode == 1
        (check,) = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
        assert field(check, "error") == "E-RETENTION-VIOLATION" and field(check, "lifecycle") == "differs"
        extra = {"Rules": LIFECYCLE_V1["Rules"] + [{"ID": "extra", "Status": "Enabled", "Filter": {"Prefix": "v1/x/"},
                                                    "Expiration": {"Days": 1}}]}
        s3.put_bucket_lifecycle_configuration(Bucket=BUCKET, LifecycleConfiguration=extra)
        proc = env.run("--check-only")
        assert proc.returncode == 1 and "error=E-RETENTION-VIOLATION" in proc.stdout
    finally:
        s3.put_bucket_lifecycle_configuration(Bucket=BUCKET, LifecycleConfiguration=LIFECYCLE_V1)
    assert env.run("--check-only").returncode == 0
    # el productor no toca el ciclo de vida: sigue siendo exactamente §9
    rules = s3.get_bucket_lifecycle_configuration(Bucket=BUCKET)["Rules"]
    assert sorted(r["ID"] for r in rules) == sorted(r["ID"] for r in LIFECYCLE_V1["Rules"])


def test_daily_check_incomplete_object_older_than_24h_warns(env):
    old = now_id(dt.timedelta(hours=-30))
    env.s3().put_object(Bucket=BUCKET, Key=env.keys(old)[0], Body=b"Salted__orphan")
    proc = env.run("--check-only")
    (check,) = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
    assert field(check, "incomplete_over_24h") == "1" and "incomplete-objects-older-than-24h" in field(check, "warnings")


def check_line(proc: subprocess.CompletedProcess) -> str:
    (line,) = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
    return line


def place_remote_pair(env: Env, bid: str, local: Path) -> tuple[str, str]:
    """Copia remota «hecha ayer» (sin pasar por el productor): objeto con metadatos y checksum + manifiesto válido."""
    okey, mkey = env.keys(bid)
    data = local.read_bytes()
    size, sha = mt.file_digest(str(local))
    s3 = env.s3()
    s3.put_object(Bucket=BUCKET, Key=okey, Body=data, ContentType="application/octet-stream",
                  ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode(),
                  ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode(),
                  Metadata={"sha256": sha, "backup-id": bid})
    manifest = mt.build_manifest(passphrase=env.passphrase, size=size, sha256=sha, backup_id=bid,
                                 deployment_id=env.deployment_id, database=env.database)
    s3.put_object(Bucket=BUCKET, Key=mkey, Body=json.dumps(manifest).encode(), ContentType="application/json")
    return okey, mkey


def test_daily_check_relocated_old_pair_does_not_satisfy_freshness(env):
    """D-01 (c): par antiguo copiado por la writer a un backup_id nuevo: regla 5 ⇒ E-RESTORE-MAC, no es fresco."""
    s3 = env.s3()
    old = now_id(dt.timedelta(hours=-40))
    local = env.make_backup(old)
    old_okey, old_mkey = place_remote_pair(env, old, local)
    local.unlink()
    Path(str(local) + ".sha256").unlink()  # ya no está en local
    new = now_id(dt.timedelta(minutes=-1))
    new_okey, new_mkey = env.keys(new)
    s3.copy_object(Bucket=BUCKET, Key=new_okey, CopySource={"Bucket": BUCKET, "Key": old_okey})
    s3.copy_object(Bucket=BUCKET, Key=new_mkey, CopySource={"Bucket": BUCKET, "Key": old_mkey})
    stamps = {k: s3.head_object(Bucket=BUCKET, Key=k)["ETag"] for k in (old_okey, old_mkey, new_okey, new_mkey)}
    proc = env.run()
    assert proc.returncode == 1
    check = check_line(proc)
    assert field(check, "complete") == "1" and field(check, "newest_backup_id") == old
    assert field(check, "invalid") == f"{new}:E-RESTORE-MAC"
    assert set(field(check, "error").split(",")) == {"E-FRESHNESS", "E-RESTORE-MAC"}
    assert lines_for(proc, new) == [] and lines_for(proc, old) == []
    assert {k: s3.head_object(Bucket=BUCKET, Key=k)["ETag"] for k in stamps} == stamps  # nada tocado
    # con un respaldo fresco legítimo, la frescura se satisface pero el par reubicado sigue señalado
    fresh = now_id()
    env.make_backup(fresh)
    proc = env.run()
    assert proc.returncode == 1
    check = check_line(proc)
    assert field(check, "complete") == "2" and field(check, "newest_backup_id") == fresh
    assert field(check, "error") == "E-RESTORE-MAC" and field(check, "invalid") == f"{new}:E-RESTORE-MAC"


def test_daily_check_detects_tampering_of_backup_older_than_24h(env):
    """D-01 (a)/(d): objeto de > 24 h sustituido por la writer ⇒ E-REMOTE-CONFLICT en la línea del respaldo
    local (fuera de ventana) y en check=daily; también cuando el respaldo ya no está en local."""
    s3 = env.s3()
    fresh = now_id(dt.timedelta(minutes=-10))
    env.make_backup(fresh)
    old = now_id(dt.timedelta(hours=-30))
    local = env.make_backup(old, plaintext=b"PGDMP-old-" + os.urandom(512))
    okey, mkey = place_remote_pair(env, old, local)
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr  # copia válida: completo, sin línea para el antiguo
    assert lines_for(proc, old) == [] and field(check_line(proc), "complete") == "2"
    size = local.stat().st_size
    s3.put_object(Bucket=BUCKET, Key=okey, Body=b"Salted__" + os.urandom(size - 8),
                  Metadata={"sha256": "0" * 64, "backup-id": old})  # mismo tamaño, otro contenido
    proc = env.run()
    assert proc.returncode == 1
    (line,) = lines_for(proc, old)
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-REMOTE-CONFLICT"
    check = check_line(proc)
    assert field(check, "complete") == "1" and field(check, "newest_backup_id") == fresh
    assert field(check, "invalid") == f"{old}:E-REMOTE-CONFLICT" and field(check, "error") == "E-REMOTE-CONFLICT"
    local.unlink()
    Path(str(local) + ".sha256").unlink()
    proc = env.run()
    assert proc.returncode == 1 and lines_for(proc, old) == []
    assert field(check_line(proc), "invalid") == f"{old}:E-REMOTE-CONFLICT"
    s3.put_object(Bucket=BUCKET, Key=okey, Body=b"Salted__" + os.urandom(100))  # truncado
    proc = env.run()
    assert field(check_line(proc), "invalid") == f"{old}:E-REMOTE-CONFLICT"
    s3.delete_object(Bucket=BUCKET, Key=okey)  # el atacante borra el objeto y deja el manifiesto
    proc = env.run()
    assert field(check_line(proc), "invalid") == f"{old}:E-REMOTE-CONFLICT"


def test_daily_check_detects_manifest_rewritten_without_key(env):
    """D-01 (b): manifiesto reescrito con tamaño/SHA coherentes con un objeto plantado, sin la clave ⇒ E-RESTORE-MAC."""
    s3 = env.s3()
    bid = now_id()
    env.make_backup(bid)
    assert env.run().returncode == 0
    okey, mkey = env.keys(bid)
    planted = b"Salted__" + os.urandom(2048)
    sha = hashlib.sha256(planted).hexdigest()
    s3.put_object(Bucket=BUCKET, Key=okey, Body=planted, ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode())
    manifest = json.loads(s3.get_object(Bucket=BUCKET, Key=mkey)["Body"].read())
    manifest["object"].update(size_bytes=len(planted), sha256=sha)  # el atacante no puede recalcular el MAC
    s3.put_object(Bucket=BUCKET, Key=mkey, Body=json.dumps(manifest).encode(), ContentType="application/json")
    proc = env.run("--check-only")
    assert proc.returncode == 1
    check = check_line(proc)
    assert field(check, "complete") == "0" and field(check, "invalid") == f"{bid}:E-RESTORE-MAC"
    assert set(field(check, "error").split(",")) == {"E-FRESHNESS", "E-RESTORE-MAC"}
    proc = env.run()  # el respaldo local sigue en ventana: paso 3 ⇒ E-REMOTE-CONFLICT, nada se sobrescribe
    assert field(lines_for(proc, bid)[0], "error") == "E-REMOTE-CONFLICT"
    assert s3.get_object(Bucket=BUCKET, Key=okey)["Body"].read() == planted


def test_attempts_counts_the_digest_retry_when_it_succeeds(tmp_path, lab, proxy):
    """D-02: un byte corrompido en tránsito en el primer PUT ⇒ 400 InvalidDigest, reintento tras releer, OK attempts=2."""
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    local = env.make_backup(bid)
    proxy.corrupt(1, when=lambda method, path: method == "PUT" and path.endswith(".dump.enc"))
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "OK" and field(line, "action") == "uploaded" and field(line, "attempts") == "2"
    assert [st for m, p, hd, st in proxy.log if m == "PUT" and p.endswith(".dump.enc")] == [400, 200]
    assert env.s3().get_object(Bucket=BUCKET, Key=env.keys(bid)[0])["Body"].read() == local.read_bytes()
    assert field(check_line(proc), "complete") == "1"
    # corrupción persistente: dos PUT rechazados ⇒ E-INTEGRITY-UPLOAD attempts=2, sin manifiesto
    bid2 = now_id(dt.timedelta(minutes=-2))
    env.make_backup(bid2)
    proxy.corrupt(5, when=lambda method, path: method == "PUT" and path.endswith(".dump.enc"))
    proc = env.run()
    (line,) = lines_for(proc, bid2)
    assert proc.returncode == 1 and field(line, "error") == "E-INTEGRITY-UPLOAD" and field(line, "attempts") == "2"
    assert head_or_none(env.s3(), env.keys(bid2)[1]) is None


def test_multipart_upload_with_lab_threshold(env):
    bid = now_id()
    local = env.make_backup(bid, plaintext=os.urandom(3 * 1024 * 1024 + 123))
    proc = env.run(extra_env={"MAINSPOT_REMOTE_LAB_SINGLE_PART_MAX": str(1024 * 1024),
                              "MAINSPOT_REMOTE_LAB_PART_SIZE": str(1024 * 1024)})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert field(lines_for(proc, bid)[0], "action") == "uploaded"
    okey, mkey = env.keys(bid)
    h = env.s3().head_object(Bucket=BUCKET, Key=okey)
    assert h["ETag"].strip('"').endswith("-4")  # 4 partes de 1 MiB (la última más pequeña)
    assert h["Metadata"]["backup-id"] == bid
    assert env.s3().get_object(Bucket=BUCKET, Key=okey)["Body"].read() == local.read_bytes()
    assert env.s3().list_multipart_uploads(Bucket=BUCKET, Prefix=okey).get("Uploads", []) == []
    assert head_or_none(env.s3(), mkey) is not None


def test_dry_run_writes_nothing(env):
    first = now_id(dt.timedelta(minutes=-5))
    env.make_backup(first)
    assert env.run().returncode == 0  # una copia completa para que la comprobación diaria sea fresca
    bid = now_id()
    env.make_backup(bid)
    proc = env.run("--dry-run")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert field(lines_for(proc, bid)[0], "action") == "dry-run"
    assert field(lines_for(proc, first)[0], "action") == "already-complete"
    assert head_or_none(env.s3(), env.keys(bid)[0]) is None and head_or_none(env.s3(), env.keys(bid)[1]) is None
    puts = [ln for ln in proc.stdout.splitlines() if "action=uploaded" in ln]
    assert puts == []


def test_config_permissions_and_lock(env):
    env.config.chmod(0o640)
    proc = env.run()
    assert proc.returncode == 1 and "error=E-CONFIG" in proc.stdout
    env.config.chmod(0o600)
    lock = env.backup_dir / ".db-backup-remote.lock"
    import fcntl
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        proc = env.run()
        assert proc.returncode == 1 and "otra_ejecucion_en_curso" in proc.stdout
    finally:
        os.close(fd)


# --- límite de tamaño (contrato 1.2.0 §8.2 paso 0; DEC-0059, DEC-0061, DEC-0063) ------------
# El límite real es 1 GiB; MAINSPOT_REMOTE_LAB_MAX_BACKUP_BYTES lo baja para no crear archivos de 1 GiB.

LIMIT_ENV = "MAINSPOT_REMOTE_LAB_MAX_BACKUP_BYTES"


def remote_total(env: Env, path: Path, bid: str) -> int:
    """objeto cifrado + manifiesto exacto que el productor construye (determinista)."""
    size, sha = mt.file_digest(str(path))
    m = mt.build_manifest(passphrase=env.passphrase, size=size, sha256=sha, backup_id=bid,
                          deployment_id=env.deployment_id, database=env.database)
    return size + len((json.dumps(m, indent=2) + "\n").encode("utf-8"))


def alert_hook(env: Env) -> Path:
    out = env.root / "alerts-delivered.jsonl"
    hook = env.root / "alert-hook.sh"
    hook.write_text(f"#!/bin/sh\ncat >> {out}\n")
    hook.chmod(0o700)
    env.write_config(MAINSPOT_REMOTE_ALERT_COMMAND=str(hook))
    return out


def requests_for(proxy: Proxy, bid: str) -> list[tuple[str, str]]:
    return [(m, p) for m, p, hd, st in proxy.log if bid in p]


def writes(proxy: Proxy) -> list[tuple[str, str]]:
    return [(m, p) for m, p, hd, st in proxy.log if m in ("PUT", "POST", "DELETE")]


def local_state(path: Path) -> tuple:
    side = Path(str(path) + ".sha256")
    return (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns, path.stat().st_size,
            side.read_bytes(), side.stat().st_mtime_ns)


def test_t01_limit_minus_one_byte_uploads_and_warns_over_80pct(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    hook_out = alert_hook(env)
    bid = now_id()
    total = remote_total(env, env.make_backup(bid), bid)
    proc = env.run(extra_env={LIMIT_ENV: str(total + 1)})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    (line,) = [ln for ln in lines_for(proc, bid) if "status=ALERT" not in ln]
    assert field(line, "status") == "OK" and field(line, "action") == "uploaded"
    assert field(line, "total_bytes") == str(total) and field(line, "limit_bytes") == str(total + 1)
    assert head_or_none(env.s3(), env.keys(bid)[1]) is not None
    (warn,) = [json.loads(x) for x in hook_out.read_text().splitlines()]
    assert warn["code"] == "SIZE-OVER-80PCT" and warn["severity"] == "warning" and warn["backup_id"] == bid


def test_t02_exact_limit_is_inclusive_and_uploads(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    total = remote_total(env, env.make_backup(bid), bid)
    proc = env.run(extra_env={LIMIT_ENV: str(total)})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    line = [ln for ln in lines_for(proc, bid) if "status=ALERT" not in ln][0]
    assert field(line, "status") == "OK" and field(line, "action") == "uploaded"
    okey, mkey = env.keys(bid)
    h, mh = env.s3().head_object(Bucket=BUCKET, Key=okey), env.s3().head_object(Bucket=BUCKET, Key=mkey)
    assert h["ContentLength"] + mh["ContentLength"] == total  # lo medido antes es lo que queda en S3


def test_t03_limit_plus_one_byte_rejected_without_any_s3_operation(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    total = remote_total(env, env.make_backup(bid), bid)
    proc = env.run(extra_env={LIMIT_ENV: str(total - 1)})
    assert proc.returncode == 1, proc.stdout + proc.stderr
    (line,) = [ln for ln in lines_for(proc, bid) if "status=ALERT" not in ln]
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-SIZE-LIMIT"
    assert field(line, "action") == "size-rejected" and field(line, "attempts") == "0"
    assert field(line, "total_bytes") == str(total) and field(line, "limit_bytes") == str(total - 1)
    assert requests_for(proxy, bid) == [] and writes(proxy) == []
    okey, mkey = env.keys(bid)
    assert head_or_none(env.s3(), okey) is None and head_or_none(env.s3(), mkey) is None


def test_t04_rejected_before_multipart_initiation(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    env.make_backup(bid, plaintext=os.urandom(2 * 1024 * 1024 + 77))
    proc = env.run(extra_env={LIMIT_ENV: str(1024 * 1024), "MAINSPOT_REMOTE_LAB_SINGLE_PART_MAX": str(1024 * 1024),
                              "MAINSPOT_REMOTE_LAB_PART_SIZE": str(1024 * 1024)})
    assert proc.returncode == 1
    assert field([ln for ln in lines_for(proc, bid) if "status=FAIL" in ln][0], "error") == "E-SIZE-LIMIT"
    assert not any(m == "POST" for m, p, hd, st in proxy.log)  # sin CreateMultipartUpload
    assert writes(proxy) == [] and requests_for(proxy, bid) == []
    assert env.s3().list_multipart_uploads(Bucket=BUCKET, Prefix=env.keys(bid)[0]).get("Uploads", []) == []


def test_t05_local_backup_and_sha256_untouched_after_rejections(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    local = env.make_backup(bid)
    before = local_state(local)
    limit = str(remote_total(env, local, bid) - 1)
    for _ in range(2):
        env.run(extra_env={LIMIT_ENV: limit})
        assert local_state(local) == before
    assert sorted(p.name for p in env.backup_dir.glob(f"{bid}*")) == [f"{bid}.dump.enc", f"{bid}.dump.enc.sha256"]


def test_t06_alert_is_sanitized_and_delivered(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    hook_out = alert_hook(env)
    bid = now_id()
    local = env.make_backup(bid)
    total = remote_total(env, local, bid)
    proc = env.run(extra_env={LIMIT_ENV: str(total - 1)})
    (event,) = [json.loads(x) for x in hook_out.read_text().splitlines()]
    assert event == {**event, "code": "E-SIZE-LIMIT", "severity": "error", "producer": "db-backup-remote",
                     "backup_id": bid, "total_bytes": total, "limit_bytes": total - 1,
                     "action": "not-uploaded-local-backup-kept"}
    assert set(event) == {"ts", "producer", "code", "severity", "backup_id", "size_bytes", "manifest_bytes",
                          "total_bytes", "limit_bytes", "action"}
    outbox = (env.backup_dir / "remote-alerts.jsonl")
    assert oct(outbox.stat().st_mode & 0o777) == "0o600" and json.loads(outbox.read_text()) == event
    (alert_line,) = [ln for ln in proc.stdout.splitlines() if "status=ALERT" in ln]
    assert field(alert_line, "delivery") == "ok" and field(alert_line, "outbox") == "ok"
    blob = hook_out.read_text() + outbox.read_text() + proc.stdout + proc.stderr + env.log_text()
    for secret in (*SECRETS, env.creds[0], env.creds[1]):
        assert secret not in blob


def test_t07_rejection_does_not_block_later_valid_backup(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    big = now_id()
    small = now_id(dt.timedelta(minutes=-30))
    big_total = remote_total(env, env.make_backup(big, plaintext=os.urandom(64 * 1024)), big)
    small_total = remote_total(env, env.make_backup(small), small)
    assert small_total < big_total
    proc = env.run(extra_env={LIMIT_ENV: str(big_total - 1)})
    assert proc.returncode == 1
    assert field([ln for ln in lines_for(proc, big) if "status=FAIL" in ln][0], "error") == "E-SIZE-LIMIT"
    ok = lines_for(proc, small)[0]
    assert field(ok, "status") == "OK" and field(ok, "action") == "uploaded"
    assert head_or_none(env.s3(), env.keys(small)[1]) is not None
    assert head_or_none(env.s3(), env.keys(big)[0]) is None


def test_t08_rejected_backup_is_not_retried_nor_realerted(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    hook_out = alert_hook(env)
    bid = now_id()
    limit = str(remote_total(env, env.make_backup(bid), bid) - 1)
    assert env.run(extra_env={LIMIT_ENV: limit}).returncode == 1
    proxy.log.clear()
    proc = env.run(extra_env={LIMIT_ENV: limit})
    (line,) = lines_for(proc, bid)
    assert field(line, "status") == "SKIPPED" and field(line, "error") == "E-SIZE-LIMIT"
    assert field(line, "action") == "size-rejected" and field(line, "attempts") == "0"
    assert requests_for(proxy, bid) == [] and writes(proxy) == []
    assert "status=ALERT" not in proc.stdout and len(hook_out.read_text().splitlines()) == 1
    # fuera de la ventana de 24 h el respaldo termina en E-UPLOAD-WINDOW (nunca se sube)
    old = now_id(dt.timedelta(hours=-25))
    env.make_backup(old, plaintext=os.urandom(64 * 1024))
    proc = env.run(extra_env={LIMIT_ENV: limit})
    assert field(lines_for(proc, old)[0], "error") == "E-UPLOAD-WINDOW"
    assert head_or_none(env.s3(), env.keys(old)[0]) is None


def test_t09_freshness_alert_persists_with_only_rejected_backups(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    limit = str(remote_total(env, env.make_backup(bid), bid) - 1)
    for args in ((), ("--check-only",)):
        proc = env.run(*args, extra_env={LIMIT_ENV: limit})
        (check,) = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
        assert field(check, "status") == "FAIL" and "E-FRESHNESS" in field(check, "error"), check
        assert proc.returncode == 1


@pytest.mark.parametrize("value", ["abc", "0", "-5", str((1 << 30) + 1), "1e6", ""])
def test_t10_invalid_limit_or_alert_config_fails_safe_without_network(tmp_path, lab, proxy, value):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    local = env.make_backup(bid)
    before = local_state(local)
    proc = env.run(extra_env={LIMIT_ENV: value})
    assert proc.returncode == 1 and "status=FAIL" in proc.stdout and "error=E-CONFIG" in proc.stdout
    assert proxy.log == [] and local_state(local) == before
    env.write_config(MAINSPOT_REMOTE_ALERT_COMMAND="relative/hook.sh")
    proc = env.run()
    assert proc.returncode == 1 and "error=E-CONFIG" in proc.stdout and proxy.log == []


def test_t11_rejection_never_counts_as_success(tmp_path, lab, proxy):
    env = Env(tmp_path, lab, lab.writer, endpoint=proxy.endpoint)
    bid = now_id()
    limit = str(remote_total(env, env.make_backup(bid), bid) - 1)
    for _ in range(2):  # primera ejecución (FAIL) y siguiente (SKIPPED): nunca OK
        proc = env.run(extra_env={LIMIT_ENV: limit})
        assert all(field(ln, "status") in ("FAIL", "SKIPPED", "ALERT") for ln in lines_for(proc, bid))
        (check,) = [ln for ln in proc.stdout.splitlines() if "check=daily" in ln]
        assert field(check, "complete") == "0"
    assert head_or_none(env.s3(), env.keys(bid)[1]) is None
    assert "status=OK" not in "\n".join(ln for ln in env.log_text().splitlines() if bid in ln)


def test_t12_alert_is_emitted_in_the_same_run_even_without_network(tmp_path, lab):
    env = Env(tmp_path, lab, lab.writer, endpoint="http://127.0.0.1:9")  # S3 inalcanzable
    hook_out = alert_hook(env)
    bid = now_id()
    limit = str(remote_total(env, env.make_backup(bid), bid) - 1)
    started = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    proc = env.run(extra_env={LIMIT_ENV: limit})
    ended = dt.datetime.now(dt.timezone.utc)
    assert proc.returncode == 1
    out = proc.stdout.splitlines()
    i_alert = next(i for i, ln in enumerate(out) if "status=ALERT" in ln)
    i_net = next(i for i, ln in enumerate(out) if "error=E-NETWORK" in ln)
    assert i_alert < i_net  # el aviso sale antes de cualquier operación S3
    (event,) = [json.loads(x) for x in hook_out.read_text().splitlines()]
    ts = dt.datetime.strptime(event["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    assert started <= ts <= ended and event["code"] == "E-SIZE-LIMIT"



def test_no_secrets_in_outputs_and_logs(tmp_path):
    assert ALL_OUTPUT and SECRETS
    blobs = list(ALL_OUTPUT)
    for log in tmp_path.parent.glob("*/backups/backup-remote.log"):
        blobs.append(log.read_text())
    for alerts in tmp_path.parent.glob("*/backups/remote-alerts.jsonl"):  # avisos del límite (1.2.0)
        blobs.append(alerts.read_text())
    assert len(blobs) > len(ALL_OUTPUT)
    joined = "\n".join(blobs)
    for secret in SECRETS:
        assert secret not in joined
    assert "Authorization" not in joined and "AWS4-HMAC-SHA256" not in joined
    assert all(re.search(r"\S+ db-backup-remote status=", ln) for ln in joined.splitlines() if " db-backup-remote " in ln)
