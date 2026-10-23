"""Validación adversarial independiente del productor remoto `scripts/ops/backup/db-backup-remote.py`
(contrato mainspot-backup-object-storage v1.1: §4, §5, §7, §8, §10–§13, §16).

Reutiliza el laboratorio de `test_remote_producer.py` (Garage `dxflrs/garage:v2.4.1` en Docker,
solo 127.0.0.1) con prefijo propio `msp-garage-lab-adv-`, un segundo bucket
`mainspot-backups-guard` (copia protegida, opción A') y una clave **guard**. Todo el tráfico del
productor pasa por un proxy de auditoría que registra método, ruta, cabeceras y cuerpo de cada
petición y permite inyectar fallos, retrasos, corrupción de bytes y la muerte del proceso en pasos
concretos. Las operaciones del «atacante» (credencial writer) y del «restaurador» (credencial
restore) van directas a Garage.

Datos y claves exclusivamente desechables; nunca se leen `~/.config/mainspot` ni `.env`.

Ejecutar:
    PYTHONPYCACHEPREFIX=/tmp/omp-pyc python3 -m pytest -p no:cacheprovider -v -rA \
        tests/ops/backup-remote/test_adversarial.py

Las pruebas de un mismo escenario (`scenario`) comparten estado y se ejecutan en el orden del
archivo; las dos últimas (lista blanca de operaciones y secretos) resumen toda la sesión.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import http.client
import http.server
import importlib.util
import json
import os
import re
import secrets
import signal
import site
import subprocess
import sys
import threading
import time
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PRODUCER = REPO / "scripts" / "ops" / "backup" / "db-backup-remote.py"
MANIFEST_TOOL = REPO / "docs" / "contracts" / "backup-object-storage" / "v1" / "reference" / "manifest_tool.py"
LAB_PREFIX = "msp-garage-lab-adv-"
GUARD_BUCKET = "mainspot-backups-guard"
LIFECYCLE_GUARD_V1 = {"Rules": [
    {"ID": "mainspot-backups-guard-v1-retention-14d", "Status": "Enabled", "Filter": {"Prefix": "v1/"},
     "Expiration": {"Days": 14}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
]}
PLAINTEXT_MARK = b"PGDMP-"  # todo texto en claro sintético empieza así: nunca debe salir por la red
INJECTED_CODES = {404: "NoSuchKey", 429: "SlowDown", 500: "InternalError", 503: "ServiceUnavailable"}


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


base = _load(HERE / "test_remote_producer.py", "remote_producer_base")  # laboratorio, Env, helpers
prod = _load(PRODUCER, "db_backup_remote_adv")                           # para las pruebas en proceso
mt = base.mt
BUCKET = base.BUCKET
boto3 = base.boto3
ClientError = base.ClientError
now_id, field, head_or_none = base.now_id, base.field, base.head_or_none

pytestmark = base.pytestmark


# --- laboratorio con copia protegida (opción A') ----------------------------------------

class AdvLab(base.GarageLab):
    def __init__(self, workdir: Path):
        super().__init__(workdir)
        self.name = LAB_PREFIX + secrets.token_hex(4)
        self.guard: tuple[str, str] = ("", "")

    def start(self) -> None:
        super().start()
        self.garage("bucket", "create", GUARD_BUCKET)
        self.guard = self._create_key("guard", "--read")                       # read en mainspot-backups
        self.garage("bucket", "allow", "--read", "--write", GUARD_BUCKET, "--key", "guard")
        self.garage("bucket", "allow", "--read", GUARD_BUCKET, "--key", "reader")  # A': restore lee la copia
        self.client(self.guard).put_bucket_lifecycle_configuration(Bucket=GUARD_BUCKET,
                                                                   LifecycleConfiguration=LIFECYCLE_GUARD_V1)


@pytest.fixture(scope="module")
def lab(tmp_path_factory):
    lab = AdvLab(tmp_path_factory.mktemp("garage"))
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


# --- proxy de auditoría con ganchos adversariales -----------------------------------------

class Record:
    __slots__ = ("method", "path", "headers", "body", "status", "injected")

    def __init__(self, method, path, headers, body, status, injected):
        self.method, self.path, self.headers, self.body, self.status, self.injected = \
            method, path, headers, body, status, injected

    @property
    def op(self) -> str:
        return s3_operation(self.method, self.path, self.headers)

    @property
    def bucket(self) -> str:
        return urlsplit(self.path).path.strip("/").split("/", 1)[0]


def s3_operation(method: str, path: str, headers: dict) -> str:
    """Nombre de la operación S3 (direccionamiento por ruta) a partir de método, ruta y cabeceras."""
    url = urlsplit(path)
    parts = url.path.strip("/").split("/", 1)
    key = parts[1] if len(parts) > 1 else ""
    q = parse_qs(url.query, keep_blank_values=True)
    low = {k.lower() for k in headers}
    if method == "HEAD":
        return "HeadObject" if key else "HeadBucket"
    if method == "GET":
        if key:
            return "GetObject"
        if "lifecycle" in q:
            return "GetBucketLifecycleConfiguration"
        if q.get("list-type") == ["2"]:
            return "ListObjectsV2"
        if "uploads" in q:
            return "ListMultipartUploads"
        return f"GET-bucket?{url.query}"
    if method == "PUT":
        if not key:
            return "PutBucketLifecycleConfiguration" if "lifecycle" in q else f"PUT-bucket?{url.query}"
        if "x-amz-copy-source" in low:
            return "CopyObject"
        if "partnumber" in {k.lower() for k in q}:
            return "UploadPart"
        return "PutObject"
    if method == "POST":
        if not key and "delete" in q:
            return "DeleteObjects"
        if "uploads" in q:
            return "CreateMultipartUpload"
        if "uploadId" in q:
            return "CompleteMultipartUpload"
        return f"POST?{url.query}"
    if method == "DELETE":
        if not key:
            return "DeleteBucketLifecycle" if "lifecycle" in q else f"DELETE-bucket?{url.query}"
        if "uploadId" in q:
            return "AbortMultipartUpload"
        return "DeleteObject"
    return f"{method}?{url.query}"


class AdvProxy:
    """Proxy inverso 127.0.0.1 → Garage. Ganchos (se reinician en cada prueba):
    `fail(status, n, when)`: responde n veces con ese código a las peticiones que cumplan when(method, path);
    `mutate(method, path, body) -> body`: altera el cuerpo de la petición antes de reenviarlo;
    `delay(method, path) -> s`: retrasa la petición; `before(method, path, headers, body)`: gancho libre
    (p. ej. matar al productor). `records` guarda TODAS las peticiones con cabeceras y cuerpo."""

    def __init__(self, upstream_port: int):
        self.upstream_port = upstream_port
        self.records: list[Record] = []
        self.reset()
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                req_headers = {k: v for k, v in self.headers.items()}
                try:
                    if proxy.before:
                        proxy.before(self.command, self.path, req_headers, body)
                    if proxy.delay:
                        time.sleep(proxy.delay(self.command, self.path) or 0.0)
                    if proxy.failures and proxy.fail_when(self.command, self.path):
                        status = proxy.failures.pop(0)
                        code = INJECTED_CODES.get(status, "ServiceUnavailable")
                        payload = (f"<?xml version='1.0'?><Error><Code>{code}</Code>"
                                   f"<Message>lab-injected {status}</Message></Error>").encode()
                        self.send_response(status)
                        self.send_header("Content-Type", "application/xml")
                        self.send_header("Content-Length", str(len(payload)))
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.wfile.write(payload)
                        proxy.records.append(Record(self.command, self.path, req_headers, body, status, True))
                        self.close_connection = True
                        return
                    sent = proxy.mutate(self.command, self.path, body) if proxy.mutate else body
                    fwd = {k: v for k, v in self.headers.items() if k.lower() not in ("connection", "expect")}
                    conn = http.client.HTTPConnection("127.0.0.1", proxy.upstream_port, timeout=120)
                    conn.request(self.command, self.path, body=sent, headers=fwd)
                    resp = conn.getresponse()
                    data = resp.read()
                    conn.close()
                    proxy.records.append(Record(self.command, self.path, req_headers, body, resp.status, False))
                    self.send_response_only(resp.status, resp.reason)
                    for k, v in resp.getheaders():
                        if k.lower() in ("connection", "transfer-encoding", "content-length"):
                            continue
                        self.send_header(k, v)
                    if self.command != "HEAD" or not resp.getheader("Content-Length"):
                        self.send_header("Content-Length", str(len(data)))
                    else:
                        self.send_header("Content-Length", resp.getheader("Content-Length"))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    if self.command != "HEAD":
                        self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # el cliente murió (prueba kill -9)
                self.close_connection = True

            do_GET = do_PUT = do_HEAD = do_POST = do_DELETE = _handle

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def reset(self) -> None:
        self.failures: list[int] = []
        self.fail_when = lambda method, path: True
        self.mutate = None
        self.delay = None
        self.before = None

    def fail(self, status: int, times: int, when=None) -> None:
        self.failures = [status] * times
        self.fail_when = when or (lambda method, path: True)

    def since(self, mark: int) -> list[Record]:
        return self.records[mark:]

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture(scope="module")
def proxy(lab):
    p = AdvProxy(lab.port)
    yield p
    p.stop()


@pytest.fixture(autouse=True)
def _reset_proxy(proxy):
    proxy.reset()
    yield
    proxy.reset()


# --- entorno por prueba --------------------------------------------------------------------

def on(method: str, suffix: str):
    return lambda m, p: m == method and urlsplit(p).path.endswith(suffix)


class AdvEnv(base.Env):
    """Env del laboratorio base + arranque sin esperar (Popen) para kill -9 y concurrencia."""

    def env_dict(self, extra: dict | None = None) -> dict[str, str]:
        env = {"PATH": os.environ["PATH"], "HOME": str(self.home), "PYTHONPYCACHEPREFIX": "/tmp/omp-pyc",
               "MAINSPOT_REMOTE_CONFIG": str(self.config), "MAINSPOT_BACKUP_DIR": str(self.backup_dir),
               "MAINSPOT_BACKUP_KEY": str(self.key_file), "PYTHONUSERBASE": site.getuserbase()}
        env.update(extra or {})
        return env

    def spawn(self, *args: str, extra_env: dict | None = None) -> subprocess.Popen:
        return subprocess.Popen([sys.executable, str(PRODUCER), *args, "--lab-allow-http"], env=self.env_dict(extra_env),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def finish(self, proc: subprocess.Popen, timeout: float = 180) -> tuple[str, str]:
        out, err = proc.communicate(timeout=timeout)
        base.ALL_OUTPUT.append(out + err)
        return out, err

    def set_passphrase(self, raw: bytes) -> None:
        self.key_file.write_bytes(raw)
        self.key_file.chmod(0o600)
        self.passphrase = mt.read_passphrase(str(self.key_file))
        base.SECRETS.add(self.passphrase.decode("utf-8", "replace").strip())


def new_env(root: Path, lab: AdvLab, proxy: AdvProxy, creds=None) -> AdvEnv:
    root.mkdir(parents=True, exist_ok=True)
    return AdvEnv(root, lab, creds or lab.writer, endpoint=proxy.endpoint)


def lines_in(text: str, backup_id: str) -> list[str]:
    return [ln for ln in text.splitlines() if re.search(rf"(?:^| )backup_id={re.escape(backup_id)}(?: |$)", ln)]


def check_line(text: str) -> str:
    (ln,) = [ln for ln in text.splitlines() if "check=daily" in ln]
    return ln


def list_all(s3, bucket: str, prefix: str) -> dict[str, dict]:
    objs, token = {}, None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        page = s3.list_objects_v2(**kw)
        for o in page.get("Contents", []):
            objs[o["Key"]] = o
        if not page.get("IsTruncated"):
            return objs
        token = page["NextContinuationToken"]


def put_consistent(s3, bucket: str, key: str, body: bytes, backup_id: str) -> None:
    """Lo que puede hacer un atacante con la writer: subir un objeto con cabeceras coherentes con SUS bytes."""
    sha = hashlib.sha256(body).hexdigest()
    s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/octet-stream",
                  ContentMD5=base64.b64encode(hashlib.md5(body).digest()).decode(),
                  ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode(),
                  Metadata={"sha256": sha, "backup-id": backup_id})


def get_bytes(s3, bucket: str, key: str) -> bytes:
    return s3.get_object(Bucket=bucket, Key=key)["Body"].read()


def stamp(s3, bucket: str, key: str) -> tuple:
    h = s3.head_object(Bucket=bucket, Key=key)
    return h["ETag"], h["LastModified"], h["ContentLength"]


def verify_cli(manifest_path: Path, manifest_key: str, object_path: Path | None, key_file: Path | None) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(MANIFEST_TOOL), "verify", "--manifest", str(manifest_path), "--manifest-key", manifest_key]
    if object_path is not None:
        cmd += ["--object", str(object_path)]
    if key_file is not None:
        cmd += ["--key", str(key_file)]
    return subprocess.run(cmd, capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PYTHONPYCACHEPREFIX": "/tmp/omp-pyc"})


def restore_drill(s3, bucket: str, prefix: str, key_file: Path, workdir: Path) -> tuple[str | None, bytes | None, list[tuple[str, str]]]:
    """§11.2 pasos 2–4 (y §11.4 con el bucket guard): listar, tomar los manifiestos del más nuevo al más
    antiguo, descargar manifiesto y objeto de `object.key`, validar con
    `manifest_tool.py verify --manifest-key <clave listada> --object --key` y descifrar el primero válido
    (§11.1: cada fallo se descarta y se prueba el anterior)."""
    workdir.mkdir(parents=True, exist_ok=True)
    manifests = sorted((k for k in list_all(s3, bucket, prefix) if k.endswith(".manifest.json")), reverse=True)
    attempts: list[tuple[str, str]] = []
    for mk in manifests:
        mpath = workdir / mk.replace("/", "_")
        mpath.write_bytes(get_bytes(s3, bucket, mk))
        try:
            okey = json.loads(mpath.read_bytes())["object"]["key"]
            opath = workdir / okey.replace("/", "_")
            opath.write_bytes(get_bytes(s3, bucket, okey))
        except (ValueError, KeyError, TypeError):
            attempts.append((mk, "manifiesto ilegible"))
            continue
        except ClientError as exc:
            attempts.append((mk, f"objeto ausente ({exc.response['Error'].get('Code')})"))
            continue
        res = verify_cli(mpath, mk, opath, key_file)
        if res.returncode != 0:
            attempts.append((mk, f"exit={res.returncode} " + " | ".join(res.stderr.strip().splitlines())))
            continue
        dec = subprocess.run(["openssl", "enc", "-d", *base.ENC_ARGS, "-pass", f"file:{key_file}"],
                             input=opath.read_bytes(), capture_output=True)
        if dec.returncode != 0:
            attempts.append((mk, "E-RESTORE-DECRYPT"))
            continue
        attempts.append((mk, "valid=true, descifrado OK"))
        return mk, dec.stdout, attempts
    return None, None, attempts


def print_table(title: str, rows: list[tuple]) -> None:
    print(f"\n{title}")
    for row in rows:
        print("  " + " | ".join(str(c) for c in row))


# ==========================================================================================
# 1. Cifrado y clave
# ==========================================================================================

def test_key_file_open_permissions_fails_closed_without_network(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    bid = now_id()
    env.make_backup(bid)
    env.key_file.chmod(0o644)
    mark = len(proxy.records)
    proc = env.run()
    assert proc.returncode == 1
    assert "status=FAIL error=E-CONFIG" in proc.stdout and "permissions_too_open" in proc.stdout
    assert proxy.since(mark) == [], "no debe abrirse ninguna conexión con una clave insegura"
    assert head_or_none(env.s3(), env.keys(bid)[0]) is None
    assert env.passphrase.decode() not in proc.stdout + proc.stderr


def test_key_file_missing_fails_closed_without_network(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    bid = now_id()
    env.make_backup(bid)
    env.key_file.unlink()
    mark = len(proxy.records)
    proc = env.run()
    assert proc.returncode == 1
    assert "status=FAIL error=E-CONFIG" in proc.stdout
    assert proxy.since(mark) == []
    assert head_or_none(env.s3(), env.keys(bid)[0]) is None


def test_key_file_empty_first_line_fails_closed(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    bid = now_id()
    env.make_backup(bid)
    real = env.key_file.read_bytes()
    env.key_file.write_bytes(b"\n" + real)  # la contraseña real queda en la segunda línea: no debe usarse
    mark = len(proxy.records)
    proc = env.run()
    assert proc.returncode == 1 and "error=E-CONFIG" in proc.stdout and "empty_passphrase" in proc.stdout
    assert proxy.since(mark) == []


def test_key_id_and_mac_derive_from_first_line_without_lf_and_match_openssl(tmp_path, lab, proxy):
    """§4.2/§7.4: `openssl -pass file:` usa la primera línea sin `\\n` (y conserva `\\r`); key_id y MAC
    deben derivarse exactamente de esos bytes. Implementación HKDF/HMAC independiente (cryptography)."""
    env = new_env(tmp_path, lab, proxy)
    first = b"adv-first-line-" + secrets.token_hex(16).encode() + b"\r"
    env.set_passphrase(first + b"\nsecond-line-" + secrets.token_hex(8).encode() + b"\n")
    assert env.passphrase == first
    bid = now_id()
    plain = b"PGDMP-adv-" + os.urandom(1024)
    local = env.make_backup(bid, plaintext=plain)  # cifrado real con `-pass file:` sobre ese archivo
    # openssl usa first (con \r) y no la línea sin \r ni la segunda línea
    ok = subprocess.run(["openssl", "enc", "-d", *base.ENC_ARGS, "-pass", "pass:" + first.decode()],
                        input=local.read_bytes(), capture_output=True)
    bad = subprocess.run(["openssl", "enc", "-d", *base.ENC_ARGS, "-pass", "pass:" + first.decode().rstrip("\r")],
                         input=local.read_bytes(), capture_output=True)
    assert ok.returncode == 0 and ok.stdout == plain and bad.returncode != 0
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    okey, mkey = env.keys(bid)
    manifest = json.loads(get_bytes(env.s3(), BUCKET, mkey))
    exp_key_id, exp_mac = independent_key_id_and_mac(first, manifest)
    assert manifest["encryption"]["key_id"] == exp_key_id
    assert manifest["authenticity"]["mac"] == exp_mac
    for wrong in (first.rstrip(b"\r"), b"second-line", first + b"\n"):
        assert independent_key_id_and_mac(wrong, manifest)[0] != exp_key_id


def independent_key_id_and_mac(passphrase: bytes, m: dict) -> tuple[str, str]:
    """§7.4 reescrito sobre `cryptography` (no sobre manifest_tool.py)."""
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives import hmac as chmac
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF

        def hkdf(info: bytes) -> bytes:
            return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"mainspot-backup/v1", info=info).derive(passphrase)

        def mac(k: bytes, msg: bytes) -> str:
            h = chmac.HMAC(k, hashes.SHA256())
            h.update(msg)
            return h.finalize().hex()
    except ImportError:  # pragma: no cover - solo si falta cryptography
        def hkdf(info: bytes) -> bytes:
            prk = hmac.new(b"mainspot-backup/v1", passphrase, hashlib.sha256).digest()
            return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()

        def mac(k: bytes, msg: bytes) -> str:
            return hmac.new(k, msg, hashlib.sha256).hexdigest()
    key_id = "msbk1-" + hkdf(b"key-id").hex()[:16]
    lines = ["mainspot-backup-manifest-mac/v1", m["backup_id"], m["deployment_id"], m["created_at"],
             m["object"]["key"], str(m["object"]["size_bytes"]), m["object"]["sha256"],
             m["encryption"]["scheme"], m["encryption"]["key_id"]]
    return key_id, mac(hkdf(b"manifest-mac"), ("\n".join(lines) + "\n").encode("utf-8"))


def test_vector_7_5_reproduced_through_the_producer(tmp_path, lab, proxy, capsys):
    """§7.5 con el productor real (en proceso para fijar `now` dentro de la ventana): contraseña pública
    de prueba, objeto `Salted__` + 00..07 + 48×00; el manifiesto subido debe tener el key_id y el MAC
    del contrato, recalculados aquí con cryptography y por `manifest_tool.py selftest`."""
    env = new_env(tmp_path, lab, proxy)
    env.deployment_id = mt.TV_DEPLOYMENT
    env.write_config()
    env.set_passphrase(mt.TV_PASSPHRASE + b"\n")
    local = env.backup_dir / f"{mt.TV_BACKUP_ID}.dump.enc"
    local.write_bytes(mt.TV_OBJECT)
    local.chmod(0o600)
    sha = hashlib.sha256(mt.TV_OBJECT).hexdigest()
    Path(str(local) + ".sha256").write_text(f"{sha}  {local.name}\n")
    assert sha == "85b2bdc9efc9003ea6adc81f662a7d1570166c68dc347a17cc0b18608526812a"  # tabla §7.5
    prod.load_boto()
    cfg = prod.Config(prod.parse_env_file(env.config),
                      {"MAINSPOT_BACKUP_DIR": str(env.backup_dir), "MAINSPOT_BACKUP_KEY": str(env.key_file)}, mt, True)
    remote = prod.Remote(cfg, False)
    producer = prod.Producer(cfg, mt, mt.read_passphrase(str(env.key_file)), prod.Log(cfg.backup_dir), remote, False)
    (bk,) = prod.discover_local(cfg.backup_dir, mt)
    remote.head_bucket_and_clock()
    producer.process(bk, bk.created_at + dt.timedelta(hours=1), set())
    out = capsys.readouterr()
    base.ALL_OUTPUT.append(out.out + out.err)
    assert not producer.failed, out.out + out.err
    okey, mkey = env.keys(mt.TV_BACKUP_ID)
    assert okey == "v1/mainspot-pilot/postgres/mainspot/2026/10/22/mainspot-db-20261022T061958Z.dump.enc"
    manifest = json.loads(get_bytes(env.s3(), BUCKET, mkey))
    key_id, mac = independent_key_id_and_mac(mt.TV_PASSPHRASE, manifest)
    assert manifest["encryption"]["key_id"] == key_id == "msbk1-4bf859a355f2abcf"
    assert manifest["authenticity"]["mac"] == mac == "dd6e517b7a3714c5801655fd0f458c6feae92eb16bf84763bf74a15d4f3e065a"
    assert manifest["object"] == {"key": okey, "size_bytes": 64, "sha256": sha}
    self_test = subprocess.run([sys.executable, str(MANIFEST_TOOL), "selftest"], capture_output=True, text=True,
                               env={"PATH": os.environ["PATH"], "PYTHONPYCACHEPREFIX": "/tmp/omp-pyc"})
    assert self_test.returncode == 0 and all(json.loads(self_test.stdout)["checks"].values())


# ==========================================================================================
# 2. Autenticidad e integridad extremo a extremo (atacante con la credencial writer)
# ==========================================================================================

class Scenario:
    """Víctima con cuatro respaldos completos B1<B2<B3<B4 (todos dentro de la ventana de 24 h) y
    cuatro ataques con la writer: (a) B4 ← objeto válido más antiguo (B3) manteniendo el manifiesto;
    (b) B3 ← manifiesto reescrito con SHA coherente con un objeto plantado (bytes de B1), sin la clave;
    (c) B1 (objeto + manifiesto) copiado a la clave más nueva B5; (d) B2 truncado a la mitad."""

    def __init__(self, env: AdvEnv):
        self.env = env
        self.plain: dict[str, bytes] = {}
        self.cipher: dict[str, bytes] = {}
        self.manifest: dict[str, dict] = {}
        self.ids: list[str] = []
        self.after_attack: dict[str, tuple] = {}


@pytest.fixture(scope="module")
def scenario(tmp_path_factory, lab, proxy):
    env = new_env(tmp_path_factory.mktemp("victim"), lab, proxy)
    sc = Scenario(env)
    for hours in (4, 3, 2, 1):
        bid = now_id(dt.timedelta(hours=-hours))
        sc.plain[bid] = b"PGDMP-victim-" + bid.encode() + b"-" + os.urandom(2048)
        sc.cipher[bid] = env.make_backup(bid, plaintext=sc.plain[bid]).read_bytes()
        sc.ids.append(bid)
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    s3 = env.s3()
    for bid in sc.ids:
        okey, mkey = env.keys(bid)
        assert field(lines_in(proc.stdout, bid)[0], "action") == "uploaded"
        sc.manifest[bid] = json.loads(get_bytes(s3, BUCKET, mkey))
        assert mt.verify(sc.manifest[bid], None, env.passphrase, mkey) == []
    b1, b2, b3, b4 = sc.ids
    b5 = now_id()
    sc.ids.append(b5)
    k = {b: env.keys(b) for b in sc.ids}
    # (a) B4: objeto sustituido por el de B3 (válido, más antiguo); manifiesto de B4 intacto
    put_consistent(s3, BUCKET, k[b4][0], sc.cipher[b3], b4)
    # (b) B3: objeto plantado (bytes de B1) y manifiesto reescrito con tamaño/SHA coherentes, MAC original
    planted = sc.cipher[b1]
    m3 = json.loads(json.dumps(sc.manifest[b3]))
    m3["object"]["size_bytes"], m3["object"]["sha256"] = len(planted), hashlib.sha256(planted).hexdigest()
    put_consistent(s3, BUCKET, k[b3][0], planted, b3)
    s3.put_object(Bucket=BUCKET, Key=k[b3][1], Body=json.dumps(m3, indent=2).encode(), ContentType="application/json")
    # (c) B1 → B5: objeto y manifiesto copiados a la clave más nueva (CopyObject con la writer)
    s3.copy_object(Bucket=BUCKET, Key=k[b5][0], CopySource={"Bucket": BUCKET, "Key": k[b1][0]})
    s3.copy_object(Bucket=BUCKET, Key=k[b5][1], CopySource={"Bucket": BUCKET, "Key": k[b1][1]})
    # (d) B2: objeto truncado a la mitad
    put_consistent(s3, BUCKET, k[b2][0], sc.cipher[b2][: len(sc.cipher[b2]) // 2], b2)
    for bid in sc.ids:
        for key in k[bid]:
            sc.after_attack[key] = stamp(s3, BUCKET, key)
    return sc


def test_restore_rejects_all_four_attacks_and_falls_back_to_valid_backup(scenario, lab, tmp_path):
    env = scenario.env
    b1, b2, b3, b4, b5 = scenario.ids
    reader = lab.client(lab.reader)
    chosen, plain, attempts = restore_drill(reader, BUCKET, env.keys(b1)[0].rsplit("/", 4)[0] + "/", env.key_file, tmp_path / "restore")
    print_table("Simulacro §11.2 (credencial restore) tras los ataques (a)-(d):", attempts)
    reasons = dict(attempts)
    assert "rule 5" in reasons[env.keys(b5)[1]], "(c) movido: debe fallar la regla 5"
    assert "sha256 mismatch" in reasons[env.keys(b4)[1]], "(a) sustituido: SHA-256 distinto"
    assert "MAC mismatch" in reasons[env.keys(b3)[1]], "(b) manifiesto reescrito sin la clave: MAC"
    assert "size mismatch" in reasons[env.keys(b2)[1]], "(d) truncado"
    assert chosen == env.keys(b1)[1] and plain == scenario.plain[b1]
    assert [mk for mk, _ in attempts] == [env.keys(b)[1] for b in (b5, b4, b3, b2, b1)]


CHECK_ONLY_OPS = {"HeadBucket", "ListObjectsV2", "GetObject", "HeadObject", "GetBucketLifecycleConfiguration"}


def test_daily_check_detects_all_four_attacks_read_only(scenario, proxy):
    """Tras la corrección de D-01: §10.1 valida cada manifiesto (reglas 1, 2, 3 y 5) y el HeadObject del
    objeto; (a) y (d) → E-REMOTE-CONFLICT, (b) y (c) → E-RESTORE-MAC; solo B1 cuenta como completo.
    La comprobación no escribe ni borra nada y no cambia ningún objeto."""
    env = scenario.env
    b1, b2, b3, b4, b5 = scenario.ids
    s3 = env.s3()
    mark = len(proxy.records)
    proc = env.run("--check-only")
    check = check_line(proc.stdout)
    ops = Counter(r.op for r in proxy.since(mark))
    print_table("Comprobación diaria §10.1 tras los ataques (corregida):", [(check,), (dict(ops),)])
    assert proc.returncode == 1 and field(check, "status") == "FAIL"
    assert field(check, "complete") == "1" and field(check, "newest_backup_id") == b1
    assert set(field(check, "error").split(",")) == {"E-REMOTE-CONFLICT", "E-RESTORE-MAC"}
    assert field(check, "invalid") == ",".join(f"{b}:{c}" for b, c in sorted(
        {b2: "E-REMOTE-CONFLICT", b3: "E-RESTORE-MAC", b4: "E-REMOTE-CONFLICT", b5: "E-RESTORE-MAC"}.items()))
    assert "E-FRESHNESS" not in check  # B1 (−4 h) sigue siendo un respaldo completo y fresco
    assert set(ops) <= CHECK_ONLY_OPS and not [r for r in proxy.since(mark) if r.method in ("PUT", "POST", "DELETE")]
    for key, before in scenario.after_attack.items():
        assert stamp(s3, BUCKET, key) == before


def test_relocated_old_pair_does_not_satisfy_freshness(tmp_path, lab, proxy):
    """Solo existe un respaldo de −27 h (válido) y su copia reubicada a un backup_id de ahora: la
    reubicación debe quedar inválida (regla 5) y la frescura debe fallar."""
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    old = now_id(dt.timedelta(hours=-27))
    local = env.make_backup(old)
    okey, mkey = env.keys(old)
    size, sha = mt.file_digest(str(local))
    manifest = mt.build_manifest(passphrase=env.passphrase, size=size, sha256=sha, backup_id=old,
                                 deployment_id=env.deployment_id, database=env.database)
    put_consistent(s3, BUCKET, okey, local.read_bytes(), old)
    s3.put_object(Bucket=BUCKET, Key=mkey, Body=json.dumps(manifest).encode(), ContentType="application/json")
    fake = now_id()
    for src, dst in zip(env.keys(old), env.keys(fake)):
        s3.copy_object(Bucket=BUCKET, Key=dst, CopySource={"Bucket": BUCKET, "Key": src})
    proc = env.run("--check-only")
    check = check_line(proc.stdout)
    print_table("Par antiguo reubicado a un backup_id actual:", [(check,)])
    assert proc.returncode == 1 and field(check, "status") == "FAIL"
    assert field(check, "complete") == "1" and field(check, "newest_backup_id") == old
    assert "E-FRESHNESS" in field(check, "error").split(",") and "E-RESTORE-MAC" in field(check, "error").split(",")
    assert field(check, "invalid") == f"{fake}:E-RESTORE-MAC"
    assert field(check, "newest_age_h").startswith("27.")


def test_producer_step3_detects_only_attacked_backups_still_local_and_in_window(scenario):
    env = scenario.env
    b1, b2, b3, b4, b5 = scenario.ids
    s3 = env.s3()
    proc = env.run()
    rows = [(bid, lines_in(proc.stdout, bid)[0].split(" db-backup-remote ", 1)[1]) for bid in (b1, b2, b3, b4)]
    rows.append((b5, "(sin línea: no es un respaldo local)" if not lines_in(proc.stdout, b5) else lines_in(proc.stdout, b5)[0]))
    print_table("Paso 3 de §8.2 del productor tras los ataques:", rows)
    print("\n".join(ln for ln in proc.stderr.splitlines() if "E-REMOTE-CONFLICT" in ln))
    assert proc.returncode == 1
    for bid in (b2, b3, b4):
        assert field(lines_in(proc.stdout, bid)[0], "error") == "E-REMOTE-CONFLICT"
    assert field(lines_in(proc.stdout, b1)[0], "action") == "already-complete"
    assert lines_in(proc.stdout, b5) == []  # la copia reubicada no corresponde a ningún respaldo local
    for key, before in scenario.after_attack.items():  # nada se sobrescribió
        assert stamp(s3, BUCKET, key) == before


def seed_remote_pair(env: AdvEnv, s3, bid: str, local: Path) -> dict:
    """Copia remota «hecha ayer» de un respaldo local: objeto + manifiesto válidos subidos con la writer."""
    okey, mkey = env.keys(bid)
    size, sha = mt.file_digest(str(local))
    manifest = mt.build_manifest(passphrase=env.passphrase, size=size, sha256=sha, backup_id=bid,
                                 deployment_id=env.deployment_id, database=env.database)
    put_consistent(s3, BUCKET, okey, local.read_bytes(), bid)
    s3.put_object(Bucket=BUCKET, Key=mkey, Body=json.dumps(manifest).encode(), ContentType="application/json")
    return manifest


def test_tampering_of_backup_older_than_24h_is_detected_without_writes(tmp_path, lab, proxy):
    """Tras la corrección de D-01: un respaldo local de −30 h con copia remota alterada por la writer se
    detecta en la ejecución horaria (E-REMOTE-CONFLICT) y en la comprobación diaria, sin subir ni tocar nada."""
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    fresh = now_id(dt.timedelta(minutes=-10))
    env.make_backup(fresh)
    old = now_id(dt.timedelta(hours=-30))
    local = env.make_backup(old, plaintext=b"PGDMP-old-" + os.urandom(512))
    okey, mkey = env.keys(old)
    manifest = seed_remote_pair(env, s3, old, local)
    put_consistent(s3, BUCKET, okey, b"Salted__" + os.urandom(local.stat().st_size - 8), old)  # alterado por la writer
    before = (stamp(s3, BUCKET, okey), stamp(s3, BUCKET, mkey))
    mark = len(proxy.records)
    proc = env.run()
    check = check_line(proc.stdout)
    print_table("Respaldo de −30 h alterado en remoto:", [(lines_in(proc.stdout, old)[0],), (check,)])
    assert proc.returncode == 1
    assert field(lines_in(proc.stdout, old)[0], "error") == "E-REMOTE-CONFLICT"
    assert field(lines_in(proc.stdout, fresh)[0], "action") == "uploaded"
    assert field(check, "status") == "FAIL" and field(check, "invalid") == f"{old}:E-REMOTE-CONFLICT"
    assert field(check, "complete") == "1" and field(check, "newest_backup_id") == fresh
    writes = [r for r in proxy.since(mark) if r.method in ("PUT", "POST", "DELETE")]
    assert all(urlsplit(r.path).path.endswith((f"{fresh}.dump.enc", f"{fresh}.manifest.json")) for r in writes)
    assert (stamp(s3, BUCKET, okey), stamp(s3, BUCKET, mkey)) == before
    assert mt.verify(manifest, str(local), env.passphrase, mkey) == []


def test_out_of_window_backup_with_rewritten_manifest_or_corrupt_local_sha_is_reported_without_writes(tmp_path, lab, proxy):
    """Regresión del cambio en `process()` fuera de la ventana: (1) manifiesto remoto reescrito sin la clave
    → E-REMOTE-CONFLICT; (2) `.sha256` local corrupto con copia remota correcta → se registra (comportamiento
    nuevo: antes se ignoraba); en ambos casos ninguna escritura y los objetos remotos no cambian."""
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    fresh = now_id(dt.timedelta(minutes=-10))
    env.make_backup(fresh)
    assert env.run().returncode == 0
    rewritten = now_id(dt.timedelta(hours=-26))
    local_r = env.make_backup(rewritten)
    m = seed_remote_pair(env, s3, rewritten, local_r)
    m["authenticity"]["mac"] = "0" * 64
    s3.put_object(Bucket=BUCKET, Key=env.keys(rewritten)[1], Body=json.dumps(m).encode(), ContentType="application/json")
    corrupt_local = now_id(dt.timedelta(hours=-28))
    local_c = env.make_backup(corrupt_local)
    seed_remote_pair(env, s3, corrupt_local, local_c)
    Path(str(local_c) + ".sha256").write_text("0" * 64 + f"  {local_c.name}\n")
    stamps = {k: stamp(s3, BUCKET, k) for b in (rewritten, corrupt_local) for k in env.keys(b)}
    mark = len(proxy.records)
    proc = env.run()
    rows = [(b, lines_in(proc.stdout, b)[0].split(" db-backup-remote ", 1)[1] if lines_in(proc.stdout, b) else "(sin línea)")
            for b in (fresh, rewritten, corrupt_local)]
    print_table("Fuera de la ventana de 24 h:", rows + [(check_line(proc.stdout),)])
    assert proc.returncode == 1
    assert field(lines_in(proc.stdout, rewritten)[0], "error") == "E-REMOTE-CONFLICT"
    assert field(lines_in(proc.stdout, corrupt_local)[0], "status") == "FAIL"
    assert field(lines_in(proc.stdout, corrupt_local)[0], "error") == "E-LOCAL-INTEGRITY"  # observación O-1
    assert field(lines_in(proc.stdout, fresh)[0], "action") == "already-complete"
    assert not [r for r in proxy.since(mark) if r.method in ("PUT", "POST", "DELETE")]
    assert {k: stamp(s3, BUCKET, k) for k in stamps} == stamps
    check = check_line(proc.stdout)
    assert field(check, "invalid") == f"{rewritten}:E-RESTORE-MAC" and field(check, "complete") == "2"


def test_daily_check_retries_transient_failures_and_stops_on_exhaustion_without_writes(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    bid = now_id()
    env.make_backup(bid)
    assert env.run().returncode == 0
    proxy.fail(503, 2, when=on("GET", ".manifest.json"))
    proc = env.run("--check-only")
    check = check_line(proc.stdout)
    assert proc.returncode == 0 and field(check, "status") == "OK" and field(check, "attempts") == "3"
    proxy.fail(503, 5, when=on("HEAD", ".dump.enc"))
    mark = len(proxy.records)
    proc = env.run("--check-only")
    print_table("Comprobación diaria con HeadObject agotado:", [(ln,) for ln in proc.stdout.splitlines()])
    assert proc.returncode == 1 and "check=daily" not in proc.stdout  # observación O-2
    assert re.search(r"db-backup-remote status=FAIL error=E-SERVER attempts=5", proc.stdout)
    assert not [r for r in proxy.since(mark) if r.method in ("PUT", "POST", "DELETE")]


# ==========================================================================================
# 3. Reintentos, integridad en tránsito y plazo
# ==========================================================================================

STEPS = [("PUT", ".dump.enc", "PutObject objeto (§8.2 paso 4)"),
         ("HEAD", ".dump.enc", "HeadObject verificación (§8.3.1)"),
         ("GET", ".dump.enc", "GetObject verificación (§8.3.2)"),
         ("PUT", ".manifest.json", "PutObject manifiesto (§8.2 paso 6)"),
         ("HEAD", ".manifest.json", "HeadObject manifiesto (§8.2 paso 6)"),
         ("GET", ".manifest.json", "GetObject manifiesto (§8.2 paso 2)")]


def complete_and_verified(env: AdvEnv, bid: str, local: Path) -> bool:
    okey, mkey = env.keys(bid)
    s3 = env.s3()
    h = head_or_none(s3, okey)
    size, sha = mt.file_digest(str(local))
    m = head_or_none(s3, mkey)
    if h is None or m is None:
        return False
    if h["ContentLength"] != size or h["ChecksumSHA256"] != base64.b64encode(bytes.fromhex(sha)).decode():
        return False
    return mt.verify(json.loads(get_bytes(s3, BUCKET, mkey)), str(local), env.passphrase, mkey) == []


def test_transient_failures_at_every_step_end_in_a_verified_complete_backup(tmp_path, lab, proxy):
    rows = []
    for i, (method, suffix, label) in enumerate(STEPS):
        env = new_env(tmp_path / f"step{i}", lab, proxy)  # un entorno por paso: un solo respaldo local cada vez
        bid = now_id()
        local = env.make_backup(bid)
        proxy.fail(503, 2, when=on(method, suffix))
        mark = len(proxy.records)
        proc = env.run()
        line = lines_in(proc.stdout, bid)[0]
        injected = [r for r in proxy.since(mark) if r.injected]
        rows.append((label, field(line, "status"), field(line, "action") if "action=" in line else field(line, "error"),
                     "attempts=" + field(line, "attempts"), f"503 inyectados={len(injected)}"))
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert field(line, "action") == "uploaded" and field(line, "attempts") == "3"
        assert proxy.failures == [] and all(r.method == method for r in injected)
        assert complete_and_verified(env, bid, local)
    print_table("503×2 intercalados por paso:", rows)


def test_exhausted_failures_never_leave_a_complete_unverified_backup(tmp_path, lab, proxy):
    rows = []
    for i, (method, suffix, label) in enumerate(STEPS[:5]):
        env = new_env(tmp_path / f"step{i}", lab, proxy)
        s3 = env.s3()
        bid = now_id()
        local = env.make_backup(bid)
        okey, mkey = env.keys(bid)
        proxy.fail(503, 5, when=on(method, suffix))
        proc = env.run()
        line = lines_in(proc.stdout, bid)[0]
        obj, man = head_or_none(s3, okey) is not None, head_or_none(s3, mkey) is not None
        rows.append((label, field(line, "status"), field(line, "error"), "attempts=" + field(line, "attempts"),
                     f"objeto={'sí' if obj else 'no'}", f"manifiesto={'sí' if man else 'no'}"))
        assert proc.returncode == 1 and field(line, "error") == "E-SERVER" and field(line, "attempts") == "5"
        if suffix == ".manifest.json" and method == "HEAD":
            # el manifiesto ya se subió (Garage validó Content-MD5 y x-amz-checksum-sha256): completo de facto
            assert man and complete_and_verified(env, bid, local)
        else:
            assert not man, "sin verificación no puede haber manifiesto"
        time.sleep(1.1)
        mark = len(proxy.records)
        proc2 = env.run()
        line2 = lines_in(proc2.stdout, bid)[0]
        assert proc2.returncode == 0, proc2.stdout + proc2.stderr
        assert complete_and_verified(env, bid, local)
        if man:
            assert field(line2, "action") == "already-complete"
            assert not [r for r in proxy.since(mark) if r.op == "PutObject"]
        else:
            assert field(line2, "action") == "uploaded"
            assert [r.op for r in proxy.since(mark) if r.op == "PutObject"] == ["PutObject", "PutObject"]
        rows[-1] += (f"siguiente ejecución: {field(line2, 'action')}",)
    print_table("503×5 por paso (estado remoto tras el fallo y tras la siguiente ejecución):", rows)


def test_complete_backup_is_never_overwritten_even_when_its_check_fails(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    bid = now_id()
    env.make_backup(bid)
    assert env.run().returncode == 0
    okey, mkey = env.keys(bid)
    before = (stamp(s3, BUCKET, okey), stamp(s3, BUCKET, mkey))
    time.sleep(1.1)
    for method, suffix in (("GET", ".manifest.json"), ("HEAD", ".dump.enc")):
        proxy.fail(503, 5, when=on(method, suffix))
        mark = len(proxy.records)
        proc = env.run()
        line = lines_in(proc.stdout, bid)[0]
        assert proc.returncode == 1 and field(line, "error") == "E-SERVER", proc.stdout
        assert not [r for r in proxy.since(mark) if r.method in ("PUT", "POST", "DELETE")]
        assert (stamp(s3, BUCKET, okey), stamp(s3, BUCKET, mkey)) == before
    # un manifiesto que de pronto «no existe» (404 falso del proxy) sí provoca una nueva subida del objeto:
    # el respaldo deja de considerarse completo (§8.2 paso 2) — se documenta, no es un fallo del contrato.
    proxy.fail(404, 1, when=on("GET", ".manifest.json"))
    mark = len(proxy.records)
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert field(lines_in(proc.stdout, bid)[0], "action") == "uploaded"
    assert [r.op for r in proxy.since(mark) if r.op == "PutObject"] == ["PutObject", "PutObject"]
    assert get_bytes(s3, BUCKET, okey) == (env.backup_dir / f"{bid}.dump.enc").read_bytes()


def flip_last_byte(body: bytes) -> bytes:
    return body[:-1] + bytes([body[-1] ^ 0x01])


def test_corrupted_body_in_transit_gets_one_retry_then_integrity_upload_without_manifest(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    bid = now_id()
    env.make_backup(bid)
    okey, mkey = env.keys(bid)
    proxy.mutate = lambda m, p, body: flip_last_byte(body) if on("PUT", ".dump.enc")(m, p) else body
    mark = len(proxy.records)
    proc = env.run()
    line = lines_in(proc.stdout, bid)[0]
    puts = [r for r in proxy.since(mark) if r.op == "PutObject"]
    print_table("Cuerpo corrompido en tránsito (1 byte) en todos los PutObject del objeto:",
                [(r.op, r.status) for r in puts] + [(line,)] + [(ln,) for ln in proc.stderr.splitlines()])
    assert proc.returncode == 1
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-INTEGRITY-UPLOAD"
    assert field(line, "attempts") == "2" and [r.status for r in puts] == [400, 400]
    assert "400:InvalidDigest" in proc.stderr
    assert head_or_none(s3, okey) is None and head_or_none(s3, mkey) is None  # Garage no guarda el objeto


def test_corrupted_body_once_is_retried_after_rereading_and_attempts_counts_both_puts(tmp_path, lab, proxy):
    """Corrupción una sola vez: el reintento tras releer el archivo local completa el respaldo y, tras la
    corrección de D-02, `attempts` cuenta los dos PutObject (400 y 200)."""
    state = {"done": False}

    def once(m, p, body):
        if on("PUT", ".dump.enc")(m, p) and not state["done"]:
            state["done"] = True
            return flip_last_byte(body)
        return body
    proxy.mutate = once
    env = new_env(tmp_path, lab, proxy)
    bid = now_id()
    local = env.make_backup(bid)
    mark = len(proxy.records)
    proc = env.run()
    puts = [r for r in proxy.since(mark) if r.op == "PutObject" and urlsplit(r.path).path.endswith(".dump.enc")]
    line = lines_in(proc.stdout, bid)[0]
    print_table("Cuerpo corrompido una sola vez:", [(r.op, r.status) for r in puts] + [(line,)])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [r.status for r in puts] == [400, 200] and field(line, "action") == "uploaded"
    assert field(line, "attempts") == "2"
    assert complete_and_verified(env, bid, local)


def test_corrupted_manifest_body_in_transit_is_rejected_and_not_written(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    bid = now_id()
    env.make_backup(bid)
    okey, mkey = env.keys(bid)
    proxy.mutate = lambda m, p, body: flip_last_byte(body) if on("PUT", ".manifest.json")(m, p) else body
    proc = env.run()
    line = lines_in(proc.stdout, bid)[0]
    assert proc.returncode == 1 and field(line, "error") == "E-INTEGRITY-UPLOAD" and field(line, "attempts") == "2"
    assert head_or_none(s3, okey) is not None and head_or_none(s3, mkey) is None
    proxy.mutate = None
    proc = env.run()
    assert proc.returncode == 0 and field(lines_in(proc.stdout, bid)[0], "action") == "uploaded"


def test_attacker_overwrites_object_during_verification_blocks_manifest(tmp_path, lab, proxy):
    """Carrera con la writer: el objeto se sustituye entre el PutObject y la verificación (§8.3.1 HEAD o
    §8.3.2 GET) → E-INTEGRITY-VERIFY sin manifiesto; la siguiente ejecución vuelve a subir y completa."""
    for step, method in (("head", "HEAD"), ("get", "GET")):
        env = new_env(tmp_path / step, lab, proxy)
        s3 = env.s3()
        bid = now_id()
        local = env.make_backup(bid)
        okey, mkey = env.keys(bid)
        state = {"done": False}

        def overwrite(m, p, headers, body, okey=okey, bid=bid):
            if on(method, ".dump.enc")(m, p) and not state["done"]:
                state["done"] = True
                put_consistent(s3, BUCKET, okey, b"Salted__" + os.urandom(local.stat().st_size - 8), bid)
        proxy.before = overwrite
        proc = env.run()
        line = lines_in(proc.stdout, bid)[0]
        assert proc.returncode == 1 and field(line, "error") == "E-INTEGRITY-VERIFY", proc.stdout + proc.stderr
        assert state["done"] and head_or_none(s3, mkey) is None
        proxy.before = None
        proc = env.run()
        assert proc.returncode == 0 and field(lines_in(proc.stdout, bid)[0], "action") == "uploaded"
        assert complete_and_verified(env, bid, local)


def test_deadline_between_object_and_manifest_then_next_run_completes(tmp_path, lab, proxy, monkeypatch, capsys):
    """Plazo total (§12): se acorta `RUN_DEADLINE_S` en proceso y un proxy lento agota el plazo justo
    después del GetObject de verificación → E-DEADLINE sin manifiesto; la siguiente ejecución completa."""
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    bid = now_id()
    local = env.make_backup(bid)
    okey, mkey = env.keys(bid)
    proxy.delay = lambda m, p: 2.5 if on("GET", ".dump.enc")(m, p) else 0.0
    monkeypatch.setattr(prod, "RUN_DEADLINE_S", 2.0)
    for k, v in env.env_dict().items():
        monkeypatch.setenv(k, v)
    mark = len(proxy.records)
    rc = prod.main(["--lab-allow-http"])
    out = capsys.readouterr()
    base.ALL_OUTPUT.append(out.out + out.err)
    print(out.out)
    assert rc == 1
    line = lines_in(out.out, bid)[0]
    assert field(line, "status") == "FAIL" and field(line, "error") == "E-DEADLINE"
    assert re.search(r"db-backup-remote status=FAIL error=E-DEADLINE attempts=\d+ duration_s=\d+$", out.out, re.M)
    ops = [r.op for r in proxy.since(mark)]
    assert ops == ["HeadBucket", "ListObjectsV2", "GetObject", "PutObject", "HeadObject", "GetObject"]
    assert head_or_none(s3, okey) is not None and head_or_none(s3, mkey) is None
    assert "check=daily" not in out.out  # la ejecución se detiene: lo pendiente pasa a la siguiente
    proxy.delay = None
    monkeypatch.setattr(prod, "RUN_DEADLINE_S", 30 * 60)
    proc = env.run()
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert field(lines_in(proc.stdout, bid)[0], "action") == "uploaded"
    assert complete_and_verified(env, bid, local)


def test_deadline_during_backoff_is_honoured(tmp_path, lab, proxy, monkeypatch, capsys):
    env = new_env(tmp_path, lab, proxy)
    bid = now_id()
    env.make_backup(bid)
    proxy.fail(503, 5, when=on("PUT", ".dump.enc"))
    monkeypatch.setattr(prod, "RUN_DEADLINE_S", 1.0)  # el primer reintento (espera ≤ 4 s) no cabe o el plazo vence
    for k, v in env.env_dict().items():
        monkeypatch.setenv(k, v)
    t0 = time.monotonic()
    rc = prod.main(["--lab-allow-http"])
    out = capsys.readouterr()
    base.ALL_OUTPUT.append(out.out + out.err)
    assert rc == 1 and "error=E-DEADLINE" in out.out
    assert time.monotonic() - t0 < 8
    assert head_or_none(env.s3(), env.keys(bid)[1]) is None


def test_multipart_part_failure_aborts_upload_and_next_run_completes(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    bid = now_id()
    local = env.make_backup(bid, plaintext=os.urandom(3 * 1024 * 1024 + 7))
    okey, mkey = env.keys(bid)
    lab_env = {"MAINSPOT_REMOTE_LAB_SINGLE_PART_MAX": str(1024 * 1024), "MAINSPOT_REMOTE_LAB_PART_SIZE": str(1024 * 1024)}
    proxy.fail(503, 5, when=lambda m, p: m == "PUT" and "partNumber=2" in p)
    mark = len(proxy.records)
    proc = env.run(extra_env=lab_env)
    line = lines_in(proc.stdout, bid)[0]
    ops = [r.op for r in proxy.since(mark)]
    print_table("Multiparte con UploadPart 2 agotado:", [(line,), (" ".join(ops),)])
    assert proc.returncode == 1 and field(line, "error") == "E-SERVER" and field(line, "attempts") == "5"
    assert "AbortMultipartUpload" in ops and "CompleteMultipartUpload" not in ops
    assert s3.list_multipart_uploads(Bucket=BUCKET, Prefix=okey).get("Uploads", []) == []
    assert head_or_none(s3, okey) is None and head_or_none(s3, mkey) is None
    # una parte corrompida en tránsito: reintento único por parte y después E-INTEGRITY-UPLOAD + abort
    proxy.mutate = lambda m, p, body: flip_last_byte(body) if (m == "PUT" and "partNumber=3" in p) else body
    mark = len(proxy.records)
    proc = env.run(extra_env=lab_env)
    line = lines_in(proc.stdout, bid)[0]
    ops = [r.op for r in proxy.since(mark)]
    assert proc.returncode == 1 and field(line, "error") == "E-INTEGRITY-UPLOAD", proc.stdout + proc.stderr
    assert "AbortMultipartUpload" in ops and head_or_none(s3, mkey) is None
    proxy.mutate = None
    proc = env.run(extra_env=lab_env)
    assert proc.returncode == 0 and field(lines_in(proc.stdout, bid)[0], "action") == "uploaded"
    assert get_bytes(s3, BUCKET, okey) == local.read_bytes() and head_or_none(s3, mkey) is not None


# ==========================================================================================
# 4. Concurrencia e idempotencia
# ==========================================================================================

def test_two_simultaneous_instances_only_one_uploads(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    bid = now_id()
    local = env.make_backup(bid)
    proxy.delay = lambda m, p: 4.0 if on("PUT", ".dump.enc")(m, p) else 0.0
    mark = len(proxy.records)
    p1, p2 = env.spawn(), env.spawn()
    outs = ["".join(env.finish(p)) for p in (p1, p2)]
    print_table("Dos instancias simultáneas:", [(p1.returncode, outs[0].strip()), (p2.returncode, outs[1].strip())])
    assert sorted([p1.returncode, p2.returncode]) == [0, 1]
    assert sum("action=uploaded" in o for o in outs) == 1
    assert sum("otra_ejecucion_en_curso" in o for o in outs) == 1
    puts = [r for r in proxy.since(mark) if r.op == "PutObject"]
    assert [urlsplit(r.path).path.endswith(".dump.enc") for r in puts] == [True, False]
    assert complete_and_verified(env, bid, local)


def test_kill9_between_object_put_and_manifest_put_is_resumed_by_next_run(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    s3 = env.s3()
    bid = now_id()
    local = env.make_backup(bid)
    okey, mkey = env.keys(bid)
    proc = env.spawn()

    def kill_on_verification_head(m, p, headers, body):
        if on("HEAD", ".dump.enc")(m, p) and proc.poll() is None:
            os.kill(proc.pid, signal.SIGKILL)
            time.sleep(0.2)
    proxy.before = kill_on_verification_head
    out, err = env.finish(proc)
    assert proc.returncode == -signal.SIGKILL, out + err
    assert lines_in(out, bid) == []  # murió antes de registrar nada
    assert head_or_none(s3, okey) is not None and head_or_none(s3, mkey) is None  # objeto incompleto
    proxy.before = None
    proc2 = env.run()
    assert proc2.returncode == 0, proc2.stdout + proc2.stderr
    assert field(lines_in(proc2.stdout, bid)[0], "action") == "uploaded"
    assert complete_and_verified(env, bid, local)


def test_same_backup_id_from_two_hosts_with_different_content_conflicts(tmp_path, lab, proxy):
    host_a = new_env(tmp_path / "host-a", lab, proxy)
    host_b = new_env(tmp_path / "host-b", lab, proxy)
    host_b.deployment_id = host_a.deployment_id
    host_b.write_config()
    host_b.set_passphrase(host_a.key_file.read_bytes())  # misma clave de cifrado, contenido distinto
    bid = now_id()
    plain_a = b"PGDMP-host-a-" + os.urandom(512)
    local_a = host_a.make_backup(bid, plaintext=plain_a)
    host_b.make_backup(bid, plaintext=b"PGDMP-host-b-" + os.urandom(512))
    assert field(lines_in(host_a.run().stdout, bid)[0], "action") == "uploaded"
    s3 = host_a.s3()
    okey, mkey = host_a.keys(bid)
    before = (stamp(s3, BUCKET, okey), stamp(s3, BUCKET, mkey))
    time.sleep(1.1)
    proc = host_b.run()
    line = lines_in(proc.stdout, bid)[0]
    assert proc.returncode == 1 and field(line, "error") == "E-REMOTE-CONFLICT"
    assert (stamp(s3, BUCKET, okey), stamp(s3, BUCKET, mkey)) == before
    assert complete_and_verified(host_a, bid, local_a)
    chosen, plain, _ = restore_drill(lab.client(lab.reader), BUCKET, host_a.keys(bid)[0].rsplit("/", 4)[0] + "/",
                                     host_a.key_file, tmp_path / "restore")
    assert chosen == mkey and plain == plain_a


# ==========================================================================================
# 5. Aislamiento de la copia protegida y 6. restauración §11.2 / §11.4
# ==========================================================================================

def test_writer_cannot_reach_guard_bucket(lab):
    w = lab.client(lab.writer)
    key = "v1/adv-iso/postgres/mainspot/2026/10/22/mainspot-db-20261022T000000Z.dump.enc"
    lab.client(lab.guard).put_object(Bucket=GUARD_BUCKET, Key=key, Body=b"Salted__guard-copy")
    probes = {
        "HeadBucket": lambda: w.head_bucket(Bucket=GUARD_BUCKET),
        "ListObjectsV2": lambda: w.list_objects_v2(Bucket=GUARD_BUCKET),
        "HeadObject": lambda: w.head_object(Bucket=GUARD_BUCKET, Key=key),
        "GetObject": lambda: w.get_object(Bucket=GUARD_BUCKET, Key=key),
        "PutObject": lambda: w.put_object(Bucket=GUARD_BUCKET, Key=key, Body=b"x"),
        "DeleteObject": lambda: w.delete_object(Bucket=GUARD_BUCKET, Key=key),
        "DeleteObjects": lambda: w.delete_objects(Bucket=GUARD_BUCKET, Delete={"Objects": [{"Key": key}]}),
        "CopyObject mainspot-backups→guard": lambda: w.copy_object(
            Bucket=GUARD_BUCKET, Key=key + ".x", CopySource={"Bucket": BUCKET, "Key": key}),
        "CopyObject guard→mainspot-backups": lambda: w.copy_object(
            Bucket=BUCKET, Key=key + ".x", CopySource={"Bucket": GUARD_BUCKET, "Key": key}),
        "GetBucketLifecycleConfiguration": lambda: w.get_bucket_lifecycle_configuration(Bucket=GUARD_BUCKET),
        "PutBucketLifecycleConfiguration": lambda: w.put_bucket_lifecycle_configuration(
            Bucket=GUARD_BUCKET, LifecycleConfiguration={"Rules": [dict(LIFECYCLE_GUARD_V1["Rules"][0], Expiration={"Days": 1})]}),
        "DeleteBucketLifecycle": lambda: w.delete_bucket_lifecycle(Bucket=GUARD_BUCKET),
        "CreateMultipartUpload": lambda: w.create_multipart_upload(Bucket=GUARD_BUCKET, Key=key + ".mp"),
    }
    rows = []
    for name, fn in probes.items():
        try:
            fn()
            rows.append((name, "PERMITIDO"))
        except ClientError as exc:
            rows.append((name, f"{exc.response['ResponseMetadata']['HTTPStatusCode']} {exc.response['Error'].get('Code')}"))
    print_table("Credencial writer sobre mainspot-backups-guard:", rows)
    assert all(r[1].startswith("403") for r in rows), rows
    g = lab.client(lab.guard)
    assert get_bytes(g, GUARD_BUCKET, key) == b"Salted__guard-copy"
    assert g.get_bucket_lifecycle_configuration(Bucket=GUARD_BUCKET)["Rules"][0]["Expiration"]["Days"] == 14
    g.delete_object(Bucket=GUARD_BUCKET, Key=key)


def test_restore_11_2_from_service_and_11_4_from_guard_with_originals_deleted(tmp_path, lab, proxy):
    env = new_env(tmp_path, lab, proxy)
    w, g, r = env.s3(), lab.client(lab.guard), lab.client(lab.reader)
    ids, plain = [], {}
    for minutes in (20, 10):
        bid = now_id(dt.timedelta(minutes=-minutes))
        plain[bid] = b"PGDMP-restore-" + bid.encode() + os.urandom(4096)
        env.make_backup(bid, plaintext=plain[bid])
        ids.append(bid)
    assert env.run().returncode == 0
    prefix = env.keys(ids[0])[0].rsplit("/", 4)[0] + "/"
    # §11.2 desde el servicio con restore: el más reciente válido, descifrado y comparado byte a byte
    chosen, got, attempts = restore_drill(r, BUCKET, prefix, env.key_file, tmp_path / "r1")
    print_table("§11.2 desde mainspot-backups:", attempts)
    assert chosen == env.keys(ids[-1])[1] and got == plain[ids[-1]]
    # copia protegida (opción A): CopyObject con guard a la misma clave; HeadObject conserva tamaño y SHA-256
    for bid in ids:
        for key in env.keys(bid):
            g.copy_object(Bucket=GUARD_BUCKET, Key=key, CopySource={"Bucket": BUCKET, "Key": key})
            a = w.head_object(Bucket=BUCKET, Key=key, ChecksumMode="ENABLED")
            b = r.head_object(Bucket=GUARD_BUCKET, Key=key, ChecksumMode="ENABLED")
            assert (a["ContentLength"], a.get("ChecksumSHA256")) == (b["ContentLength"], b.get("ChecksumSHA256"))
            assert hashlib.sha256(get_bytes(r, GUARD_BUCKET, key)).hexdigest() == hashlib.sha256(get_bytes(r, BUCKET, key)).hexdigest()
    # §9.2.6 pasos 3–4: la writer borra los originales y altera el ciclo de vida; la copia sigue intacta
    for bid in ids:
        for key in env.keys(bid):
            w.delete_object(Bucket=BUCKET, Key=key)
    w.delete_bucket_lifecycle(Bucket=BUCKET)
    w.put_bucket_lifecycle_configuration(Bucket=BUCKET, LifecycleConfiguration={"Rules": [
        dict(base.LIFECYCLE_V1["Rules"][0], Expiration={"Days": 1})]})
    try:
        assert list_all(r, BUCKET, prefix) == {}
        for bid in ids:
            for key in env.keys(bid):
                for fn in (lambda: w.delete_object(Bucket=GUARD_BUCKET, Key=key), lambda: w.get_object(Bucket=GUARD_BUCKET, Key=key)):
                    with pytest.raises(ClientError) as exc:
                        fn()
                    assert exc.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403
        chosen, got, attempts = restore_drill(r, BUCKET, prefix, env.key_file, tmp_path / "r2")
        assert chosen is None and attempts == []  # §11.2 paso 3: falta todo → §11.4
        chosen, got, attempts = restore_drill(r, GUARD_BUCKET, prefix, env.key_file, tmp_path / "r3")
        print_table("§11.4 desde mainspot-backups-guard con originales borrados:", attempts)
        assert chosen == env.keys(ids[-1])[1] and got == plain[ids[-1]]
        # el productor detecta el ciclo de vida alterado y el hueco (los originales de < 24 h se vuelven a subir)
        proc = env.run()
        check = check_line(proc.stdout)
        assert proc.returncode == 1 and "E-RETENTION-VIOLATION" in field(check, "error") and field(check, "lifecycle") == "differs"
        assert all(field(lines_in(proc.stdout, b)[0], "action") == "uploaded" for b in ids)
    finally:
        w.put_bucket_lifecycle_configuration(Bucket=BUCKET, LifecycleConfiguration=base.LIFECYCLE_V1)
    assert env.run("--check-only").returncode == 0


# ==========================================================================================
# 5 (cont.) y 7: lista blanca de operaciones observadas, nada secreto en la red ni en los registros
# ==========================================================================================

PRODUCER_ALLOWED = {"HeadBucket", "ListObjectsV2", "HeadObject", "GetObject", "GetBucketLifecycleConfiguration",
                    "PutObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload"}
PRODUCER_FORBIDDEN = {"DeleteObject", "DeleteObjects", "CopyObject", "PutBucketLifecycleConfiguration",
                      "DeleteBucketLifecycle", "ListMultipartUploads"}


def test_observed_s3_operations_whitelist_and_nothing_secret_on_the_wire(proxy):
    assert proxy.records, "el proxy de auditoría no vio tráfico"
    counts = Counter(r.op for r in proxy.records)
    print_table("Operaciones S3 observadas del productor (todas las pruebas, vía proxy):",
                sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
    assert set(counts) <= PRODUCER_ALLOWED, set(counts) - PRODUCER_ALLOWED
    assert not (set(counts) & PRODUCER_FORBIDDEN)
    assert {r.bucket for r in proxy.records} == {BUCKET}
    for r in proxy.records:
        key = urlsplit(r.path).path.strip("/").split("/", 1)
        if len(key) > 1:
            assert re.fullmatch(r"v1/[a-z0-9-]+/postgres/mainspot/\d{4}/\d{2}/\d{2}/mainspot-db-\d{8}T\d{6}Z\.(dump\.enc|manifest\.json)", key[1]), r.path
        low = {k.lower(): v for k, v in r.headers.items()}
        assert low.get("authorization", "").startswith("AWS4-HMAC-SHA256 ")  # firmada, nunca anónima
        if r.op in ("PutObject", "UploadPart", "CreateMultipartUpload"):
            assert "x-amz-trailer" not in low and "transfer-encoding" not in low
        if r.op == "PutObject" and urlsplit(r.path).path.endswith(".dump.enc"):
            assert r.body.startswith(b"Salted__") and "content-md5" in low and "x-amz-checksum-sha256" in low
        blob = r.body + "\n".join(f"{k}: {v}" for k, v in r.headers.items()).encode("utf-8", "replace")
        assert PLAINTEXT_MARK not in blob, r.path
        for secret in base.SECRETS:
            if len(secret) >= 16 and not secret.startswith("GK"):  # el access key id sí viaja en Authorization
                assert secret.encode() not in blob, f"secreto en la petición {r.method} {r.path}"
    assert all(b"Salted__" not in r.body or r.op in ("PutObject", "UploadPart") for r in proxy.records)


def test_no_secrets_in_any_output_or_log(tmp_path):
    assert base.ALL_OUTPUT and base.SECRETS
    blobs = list(base.ALL_OUTPUT)
    logs = list(tmp_path.parent.glob("*/backups/backup-remote.log")) + list(tmp_path.parent.glob("*/*/backups/backup-remote.log"))
    blobs += [p.read_text() for p in logs]
    assert len(logs) >= 10, logs
    joined = "\n".join(blobs)
    for secret in base.SECRETS:
        assert secret not in joined
    for needle in ("Authorization", "AWS4-HMAC-SHA256", "Signature=", "X-Amz-Credential", "PGDMP-", "TEST-VECTOR-ONLY"):
        assert needle not in joined, needle
    for ln in joined.splitlines():
        if " db-backup-remote " in ln:
            assert re.search(r"\S+ db-backup-remote (status=(OK|FAIL|SKIPPED|DISABLED)|check=daily)", ln), ln
    print_table("Salidas y registros revisados:", [("ejecuciones capturadas", len(base.ALL_OUTPUT)), ("backup-remote.log", len(logs)),
                                                   ("secretos buscados", len(base.SECRETS))])
