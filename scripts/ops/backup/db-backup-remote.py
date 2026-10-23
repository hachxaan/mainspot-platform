#!/usr/bin/env python3
"""db-backup-remote.py — copia remota del respaldo cifrado de MainSpot a Garage S3.

Implementa el productor del contrato `mainspot-backup-object-storage` v1
(docs/contracts/backup-object-storage/v1/CONTRACT.md): §8.2 subida, §8.3
verificación, §8.4 integridad en tránsito, §8.5 multiparte, §10.1 comprobación
diaria, §12 reintentos, §13 errores y §16.3 registro.

DESACTIVADO POR DEFECTO. Sin el archivo de configuración
`~/.config/mainspot/backup/remote.env` (ruta sobreescribible con
`MAINSPOT_REMOTE_CONFIG`), o con `MAINSPOT_REMOTE_BACKUP_ENABLED` distinto de `1`,
termina con `status=DISABLED`, código 0 y sin abrir ninguna conexión ni leer la
clave de cifrado.

Archivo de configuración (permisos 0600; `CLAVE=valor` por línea; `#` comenta):

    MAINSPOT_REMOTE_BACKUP_ENABLED=1
    S3_ENDPOINT=https://s3.mainspot.canonflow.dev
    S3_REGION=garage
    S3_BUCKET=mainspot-backups
    DEPLOYMENT_ID=mainspot-pilot
    DATABASE=mainspot
    AWS_ACCESS_KEY_ID=…            (credencial mainspot-backup-writer, §6.4)
    AWS_SECRET_ACCESS_KEY=…
    MAINSPOT_BACKUP_DIR=…          (opcional; el entorno tiene prioridad)
    MAINSPOT_BACKUP_KEY=…          (opcional; el entorno tiene prioridad)

Entorno (no secreto): `MAINSPOT_BACKUP_DIR` (defecto ~/.local/share/mainspot/backups),
`MAINSPOT_BACKUP_KEY` (defecto ~/.config/mainspot/backup/backup.key; se lee solo
para derivar `key_id` y el MAC del manifiesto, nunca se imprime ni se envía).

Uso: db-backup-remote.py [--check-only] [--dry-run] [--lab-allow-http]
  --check-only      solo la comprobación diaria de §10.1 (no sube nada)
  --dry-run         todo salvo las escrituras (ningún PutObject ni multiparte)
  --lab-allow-http  admite `http://` (solo laboratorios; el contrato exige https)

Salida: 0 (OK, DISABLED o SKIPPED), 1 (algún FAIL), 2 (uso o dependencias).
Registro: una línea por respaldo (§16.3) en stdout y en
`$MAINSPOT_BACKUP_DIR/backup-remote.log`, nunca con secretos. El productor nunca
borra objetos ni cambia la configuración del bucket (§8.6).
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # no __pycache__ en el repositorio (manifest_tool se importa por ruta)

import argparse
import base64
import datetime as dt
import email.utils
import fcntl
import hashlib
import importlib.util
import json
import os
import random
import re
import stat
import time
from pathlib import Path

PRODUCER = "db-backup-remote"
REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_TOOL = REPO_ROOT / "docs" / "contracts" / "backup-object-storage" / "v1" / "reference" / "manifest_tool.py"
DEFAULT_CONFIG = Path.home() / ".config" / "mainspot" / "backup" / "remote.env"
DEFAULT_BACKUP_DIR = Path.home() / ".local" / "share" / "mainspot" / "backups"
DEFAULT_KEY = Path.home() / ".config" / "mainspot" / "backup" / "backup.key"
DEFAULT_ENDPOINT = "https://s3.mainspot.canonflow.dev"
DEFAULT_REGION = "garage"
DEFAULT_BUCKET = "mainspot-backups"
DEFAULT_DEPLOYMENT = "mainspot-pilot"
DEFAULT_DATABASE = "mainspot"

# §8.2 / §10.1 / §9
UPLOAD_WINDOW = dt.timedelta(hours=24)
FRESHNESS_MAX = dt.timedelta(hours=26)
RETENTION_BOUND = dt.timedelta(days=16)
ORPHAN_MAX_AGE = dt.timedelta(hours=24)
COMPLETE_RANGE = (13, 16)
DATA_PREFIX = "v1/"
CONFORMANCE_PREFIX = "_conformance/"
RETENTION_DAYS = 14
# Misma forma que LIFECYCLE_V1 de conformance/check_s3_backup_contract.py (§9).
LIFECYCLE_V1 = {"Rules": [
    {"ID": "mainspot-backups-v1-retention-14d", "Status": "Enabled", "Filter": {"Prefix": DATA_PREFIX},
     "Expiration": {"Days": RETENTION_DAYS}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
    {"ID": "mainspot-backups-conformance-1d", "Status": "Enabled", "Filter": {"Prefix": CONFORMANCE_PREFIX},
     "Expiration": {"Days": 1}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
]}

# §12
MAX_ATTEMPTS = 5
BACKOFF_CAP_S = 60.0
CONNECT_TIMEOUT_S = 10
READ_TIMEOUT_S = 120
UPLOAD_READ_TIMEOUT_S = 600
RUN_DEADLINE_S = 30 * 60
MAX_SKEW_S = 300
# §8.5 (los MAINSPOT_REMOTE_LAB_* solo sirven para probar la ruta multiparte en laboratorio)
SINGLE_PART_MAX = int(os.environ.get("MAINSPOT_REMOTE_LAB_SINGLE_PART_MAX", 256 * 1024 * 1024))
PART_SIZE = int(os.environ.get("MAINSPOT_REMOTE_LAB_PART_SIZE", 64 * 1024 * 1024))

RETRYABLE_CODES = {"SlowDown", "InternalError", "ServiceUnavailable", "RequestTimeout"}
SHA256_LINE_RE = re.compile(r"^([0-9a-f]{64})  (\S+)\n?\Z")

# Rellenados por load_boto() solo cuando el productor está activado.
boto3 = None
botocore_exceptions = None
BotoConfig = None


def load_manifest_tool():
    spec = importlib.util.spec_from_file_location("manifest_tool", MANIFEST_TOOL)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"no se encuentra {MANIFEST_TOOL}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_boto() -> None:
    global boto3, botocore_exceptions, BotoConfig
    import boto3 as _boto3
    import botocore.exceptions as _exc
    from botocore.config import Config as _Config
    boto3, botocore_exceptions, BotoConfig = _boto3, _exc, _Config


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def md5_b64(data: bytes) -> str:
    return base64.b64encode(hashlib.md5(data).digest()).decode()


def sha256_b64(hex_digest: str) -> str:
    return base64.b64encode(bytes.fromhex(hex_digest)).decode()


class ProducerError(Exception):
    """Fallo clasificado con un código de §13 (o un motivo local)."""

    def __init__(self, code: str, detail: str = "", attempts: int = 1):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code, self.detail, self.attempts = code, detail, attempts


class Log:
    def __init__(self, backup_dir: Path | None):
        self.backup_dir = backup_dir
        self.lines: list[str] = []

    def emit(self, status: str, **fields) -> None:
        parts = [f"status={status}"] + [f"{k}={v}" for k, v in fields.items() if v is not None and v != ""]
        line = f"{iso(utcnow())} {PRODUCER} " + " ".join(parts)
        self.lines.append(line)
        print(line, flush=True)
        if self.backup_dir and self.backup_dir.is_dir():
            path = self.backup_dir / "backup-remote.log"
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                pass


# --- configuración -----------------------------------------------------------------

def parse_env_file(path: Path) -> dict[str, str]:
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise ProducerError("E-CONFIG", f"permisos demasiado amplios en la configuración ({oct(mode)}); se exige 0600")
    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip().strip('"').strip("'")
    return values


class Config:
    def __init__(self, values: dict[str, str], env: dict[str, str], mt, allow_http: bool):
        self.endpoint = values.get("S3_ENDPOINT", DEFAULT_ENDPOINT)
        self.region = values.get("S3_REGION", DEFAULT_REGION)
        self.bucket = values.get("S3_BUCKET", DEFAULT_BUCKET)
        self.deployment_id = values.get("DEPLOYMENT_ID", DEFAULT_DEPLOYMENT)
        self.database = values.get("DATABASE", DEFAULT_DATABASE)
        self.access_key = values.get("AWS_ACCESS_KEY_ID", "")
        self.secret_key = values.get("AWS_SECRET_ACCESS_KEY", "")
        self.backup_dir = Path(env.get("MAINSPOT_BACKUP_DIR") or values.get("MAINSPOT_BACKUP_DIR") or DEFAULT_BACKUP_DIR)
        self.key_file = Path(env.get("MAINSPOT_BACKUP_KEY") or values.get("MAINSPOT_BACKUP_KEY") or DEFAULT_KEY)
        scheme = self.endpoint.split("://", 1)[0].lower() if "://" in self.endpoint else ""
        if scheme != "https" and not (allow_http and scheme == "http"):
            raise ProducerError("E-CONFIG", "S3_ENDPOINT debe ser https:// (contrato §6.1)")
        if not mt.DEPLOYMENT_RE.match(self.deployment_id):
            raise ProducerError("E-CONFIG", "DEPLOYMENT_ID inválido (§7.2)")
        if not mt.DATABASE_RE.match(self.database):
            raise ProducerError("E-CONFIG", "DATABASE inválido (§7.2)")
        if not self.bucket or not self.region:
            raise ProducerError("E-CONFIG", "S3_BUCKET y S3_REGION son obligatorios")
        if not self.access_key or not self.secret_key:
            raise ProducerError("E-CONFIG", "faltan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY")
        self.prefix = f"{DATA_PREFIX}{self.deployment_id}/postgres/{self.database}/"


# --- respaldos locales -------------------------------------------------------------

class LocalBackup:
    def __init__(self, path: Path, backup_id: str, created_at: dt.datetime):
        self.path, self.backup_id, self.created_at = path, backup_id, created_at
        self.sha256_path = Path(str(path) + ".sha256")
        self.size = 0
        self.sha256 = ""
        self.md5_b64 = ""

    def verify_local(self) -> None:
        """§8.2 paso 1: el .sha256 (formato sha256sum) debe coincidir con el archivo."""
        try:
            m = SHA256_LINE_RE.match(self.sha256_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            m = None
        if not m or m.group(2) not in (self.path.name, f"*{self.path.name}"):
            raise ProducerError("E-LOCAL-INTEGRITY", f"{self.sha256_path.name}: formato inesperado")
        expected = m.group(1)
        sha, md5, size = hashlib.sha256(), hashlib.md5(), 0
        with open(self.path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                sha.update(chunk)
                md5.update(chunk)
                size += len(chunk)
        if sha.hexdigest() != expected:
            raise ProducerError("E-LOCAL-INTEGRITY", f"{self.path.name}: SHA-256 distinto de {self.sha256_path.name}")
        self.size, self.sha256 = size, expected
        self.md5_b64 = base64.b64encode(md5.digest()).decode()


def discover_local(backup_dir: Path, mt) -> list[LocalBackup]:
    found = []
    for p in backup_dir.glob("mainspot-db-*.dump.enc"):
        if not p.is_file() or not Path(str(p) + ".sha256").is_file():
            continue
        backup_id = p.name[: -len(".dump.enc")]
        if not mt.BACKUP_ID_RE.match(backup_id):
            continue
        created = dt.datetime.strptime(mt.created_at(backup_id), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        found.append(LocalBackup(p, backup_id, created))
    return sorted(found, key=lambda b: b.backup_id, reverse=True)


# --- cliente S3 con reintentos (§12) -----------------------------------------------

NOT_FOUND = "NOT-FOUND"


def err_code(exc: Exception) -> str:
    if isinstance(exc, botocore_exceptions.ClientError):
        e = exc.response.get("Error", {})
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return f"{status}:{e.get('Code', '?')}"
    return type(exc).__name__


def classify(exc: Exception) -> tuple[str, bool]:
    """Devuelve (código §13, reintentable) para una excepción de boto3/botocore. Sin secretos."""
    ex = botocore_exceptions
    if isinstance(exc, ex.ClientError):
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0
        code = exc.response.get("Error", {}).get("Code", "")
        if status in (500, 502, 504) or code in ("InternalError",):
            return "E-SERVER", True
        if status == 503 or code in ("ServiceUnavailable",):
            return "E-SERVER", True
        if status == 429 or code == "SlowDown":
            return "E-THROTTLE", True
        if code == "RequestTimeout":
            return "E-NETWORK", True
        if status == 403 or code in ("AccessDenied", "InvalidAccessKeyId"):
            return "E-AUTH-DENIED", False
        if code in ("AuthorizationHeaderMalformed", "SignatureDoesNotMatch"):
            return "E-AUTH-SIGNATURE", False
        if code == "InvalidRequest":
            return "E-AUTH-SKEW", False
        if code == "NoSuchBucket":
            return "E-BUCKET", False
        if status == 501 or code == "NotImplemented":
            return "E-NOT-IMPLEMENTED", False
        if code in ("InvalidDigest", "BadDigest"):
            return "E-INTEGRITY-UPLOAD", False
        if status == 404 or code in ("NoSuchKey", "NotFound"):
            return NOT_FOUND, False
        return "E-REQUEST", False
    if isinstance(exc, ex.SSLError):
        return "E-TLS", False
    if isinstance(exc, (ex.ConnectionError, ex.HTTPClientError, ex.ConnectTimeoutError, ex.ReadTimeoutError)):
        return "E-NETWORK", True
    if isinstance(exc, (OSError, TimeoutError)):
        return "E-NETWORK", True
    return "E-REQUEST", False


class Remote:
    def __init__(self, cfg: Config, dry_run: bool):
        self.cfg, self.dry_run = cfg, dry_run
        self.started = time.monotonic()
        self.deadline = self.started + RUN_DEADLINE_S
        self.max_attempts = 1  # máximo de peticiones de una operación lógica dentro del respaldo en curso (§16.3)
        self.last_attempts = 1  # peticiones de la última llamada a call() que tuvo éxito
        self.skew_s: float | None = None
        self.s3 = self._client(READ_TIMEOUT_S)
        self.s3_upload = self._client(UPLOAD_READ_TIMEOUT_S)

    def _client(self, read_timeout: int):
        try:
            cfg = BotoConfig(
                signature_version="s3v4",
                s3={"addressing_style": "path", "payload_signing_enabled": True},
                # Sin reintentos propios de botocore (total_max_attempts=1): la política de §12 la aplica call().
                retries={"total_max_attempts": 1, "mode": "standard"},
                connect_timeout=CONNECT_TIMEOUT_S,
                read_timeout=read_timeout,
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            )
        except TypeError as exc:
            raise ProducerError("E-CONFIG", "se requiere boto3/botocore >= 1.36 (request_checksum_calculation)") from exc
        return boto3.client("s3", endpoint_url=self.cfg.endpoint, region_name=self.cfg.region,
                            aws_access_key_id=self.cfg.access_key, aws_secret_access_key=self.cfg.secret_key,
                            config=cfg)

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    def reset_attempts(self) -> None:
        self.max_attempts = 1

    def _measure_skew(self, headers: dict) -> None:
        if self.skew_s is not None:
            return
        date = headers.get("date") or headers.get("Date")
        if not date:
            return
        try:
            server = email.utils.parsedate_to_datetime(date)
        except (TypeError, ValueError):
            return
        if server.tzinfo is None:
            server = server.replace(tzinfo=dt.timezone.utc)
        self.skew_s = abs((server - utcnow()).total_seconds())

    def call(self, label: str, fn, *, allow_404: bool = False):
        """Ejecuta fn() con la política de §12. Devuelve None en 404 si allow_404."""
        attempts = 0
        while True:
            if self.remaining() <= 0:
                raise ProducerError("E-DEADLINE", f"{label}: plazo total agotado", attempts or 1)
            attempts += 1
            self.max_attempts = max(self.max_attempts, attempts)
            try:
                resp = fn()
            except Exception as exc:  # noqa: BLE001 - toda excepción se clasifica, nunca se imprime entera
                if isinstance(exc, botocore_exceptions.ClientError):
                    self._measure_skew(exc.response.get("ResponseMetadata", {}).get("HTTPHeaders", {}))
                code, retryable = classify(exc)
                if code == NOT_FOUND:
                    if allow_404:
                        return None
                    code = "E-REQUEST"
                if retryable and attempts < MAX_ATTEMPTS:
                    wait = random.uniform(0.0, min(BACKOFF_CAP_S, 2.0 * 2 ** attempts))
                    if wait >= self.remaining():
                        raise ProducerError("E-DEADLINE", f"{label}: plazo total agotado durante el reintento", attempts)
                    time.sleep(wait)
                    continue
                raise ProducerError(code, f"{label}: {err_code(exc)}", attempts) from None
            if isinstance(resp, dict):
                self._measure_skew(resp.get("ResponseMetadata", {}).get("HTTPHeaders", {}))
            self.last_attempts = attempts
            return resp

    # --- operaciones -------------------------------------------------------------

    def head_bucket_and_clock(self) -> None:
        """Primera petición de la ejecución: HeadBucket y medición del reloj (§6.5)."""
        try:
            self.call("HeadBucket", lambda: self.s3.head_bucket(Bucket=self.cfg.bucket))
        except ProducerError as exc:
            if exc.code == "E-REQUEST":  # un 404 en HeadBucket es un bucket inexistente
                raise ProducerError("E-BUCKET", exc.detail, exc.attempts) from None
            raise
        if self.skew_s is not None and self.skew_s > MAX_SKEW_S:
            raise ProducerError("E-AUTH-SKEW", f"diferencia de reloj {self.skew_s:.0f}s > {MAX_SKEW_S}s")

    def list_prefix(self) -> list[dict]:
        objects, token = [], None
        while True:
            kw = {"Bucket": self.cfg.bucket, "Prefix": self.cfg.prefix}
            if token:
                kw["ContinuationToken"] = token
            page = self.call("ListObjectsV2", lambda kw=kw: self.s3.list_objects_v2(**kw))
            objects += page.get("Contents", [])
            if not page.get("IsTruncated"):
                return objects
            token = page["NextContinuationToken"]

    def get_json(self, key: str) -> dict | None:
        resp = self.call("GetObject manifest", lambda: self.s3.get_object(Bucket=self.cfg.bucket, Key=key), allow_404=True)
        if resp is None:
            return None
        try:
            body = resp["Body"].read()
        except Exception as exc:  # noqa: BLE001
            raise ProducerError("E-NETWORK", f"GetObject manifest: lectura del cuerpo ({type(exc).__name__})") from None
        try:
            m = json.loads(body)
        except ValueError:
            raise ProducerError("E-REMOTE-CONFLICT", f"{key}: el manifiesto remoto no es JSON") from None
        if not isinstance(m, dict):
            raise ProducerError("E-REMOTE-CONFLICT", f"{key}: el manifiesto remoto no es un objeto JSON")
        return m

    def head(self, key: str) -> dict | None:
        return self.call("HeadObject", lambda: self.s3.head_object(Bucket=self.cfg.bucket, Key=key, ChecksumMode="ENABLED"),
                         allow_404=True)

    def object_matches(self, key: str, size: int, sha256_hex: str) -> tuple[bool, str]:
        """§5.3 / §8.3 paso 1: HeadObject con x-amz-checksum-mode: tamaño y, en una parte, SHA-256."""
        h = self.head(key)
        if h is None:
            return False, "el objeto remoto no existe"
        if h.get("ContentLength") != size:
            return False, f"Content-Length remoto {h.get('ContentLength')} != {size}"
        if size <= SINGLE_PART_MAX and h.get("ChecksumSHA256") != sha256_b64(sha256_hex):
            return False, "x-amz-checksum-sha256 remoto distinto del SHA-256 local"
        return True, ""

    def get_sha256(self, key: str) -> tuple[int, str]:
        resp = self.call("GetObject", lambda: self.s3.get_object(Bucket=self.cfg.bucket, Key=key))
        h, size = hashlib.sha256(), 0
        try:
            for chunk in resp["Body"].iter_chunks(1 << 20):
                h.update(chunk)
                size += len(chunk)
        except Exception as exc:  # noqa: BLE001
            raise ProducerError("E-NETWORK", f"GetObject: lectura del cuerpo ({type(exc).__name__})") from None
        return size, h.hexdigest()

    def put_with_digest_retry(self, label: str, bk: LocalBackup, do_put) -> None:
        """§12: ante InvalidDigest/BadDigest, un solo reintento tras releer y comprobar el archivo local.
        Las peticiones de ambos intentos cuentan juntas en `attempts` (§16.3)."""
        try:
            self.call(label, do_put)
        except ProducerError as exc:
            if exc.code != "E-INTEGRITY-UPLOAD":
                raise
            bk.verify_local()
            try:
                self.call(label + " (reintento tras releer)", do_put)
            except ProducerError as exc2:
                if exc2.code == "E-INTEGRITY-UPLOAD":
                    raise ProducerError("E-INTEGRITY-UPLOAD", exc2.detail, exc.attempts + exc2.attempts) from None
                raise
            self.max_attempts = max(self.max_attempts, exc.attempts + self.last_attempts)

    def put_object_single(self, bk: LocalBackup, key: str) -> None:
        def do_put():
            with open(bk.path, "rb") as fh:
                return self.s3_upload.put_object(
                    Bucket=self.cfg.bucket, Key=key, Body=fh, ContentLength=bk.size,
                    ContentType="application/octet-stream", ContentMD5=bk.md5_b64,
                    ChecksumSHA256=sha256_b64(bk.sha256),
                    Metadata={"sha256": bk.sha256, "backup-id": bk.backup_id})
        self.put_with_digest_retry("PutObject", bk, do_put)

    def put_object_multipart(self, bk: LocalBackup, key: str) -> None:
        """§8.5: partes de PART_SIZE con Content-MD5; AbortMultipartUpload si no se completa."""
        up = self.call("CreateMultipartUpload", lambda: self.s3_upload.create_multipart_upload(
            Bucket=self.cfg.bucket, Key=key, ContentType="application/octet-stream",
            Metadata={"sha256": bk.sha256, "backup-id": bk.backup_id}))
        upload_id = up["UploadId"]
        parts: list[dict] = []
        try:
            with open(bk.path, "rb") as fh:
                number = 0
                while True:
                    offset = fh.tell()
                    data = fh.read(PART_SIZE)
                    if not data:
                        break
                    number += 1

                    def do_part(n=number, off=offset):
                        with open(bk.path, "rb") as part_fh:
                            part_fh.seek(off)
                            chunk = part_fh.read(PART_SIZE)
                        return self.s3_upload.upload_part(Bucket=self.cfg.bucket, Key=key, UploadId=upload_id,
                                                          PartNumber=n, Body=chunk, ContentMD5=md5_b64(chunk))
                    result: dict = {}

                    def do_part_capture(n=number, off=offset):
                        result.update(do_part(n, off))
                        return result
                    self.put_with_digest_retry(f"UploadPart {number}", bk, do_part_capture)
                    parts.append({"PartNumber": number, "ETag": result["ETag"]})
            self.call("CompleteMultipartUpload", lambda: self.s3_upload.complete_multipart_upload(
                Bucket=self.cfg.bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts}))
        except BaseException:
            try:
                self.s3_upload.abort_multipart_upload(Bucket=self.cfg.bucket, Key=key, UploadId=upload_id)
            except Exception:  # noqa: BLE001 - la subida abandonada expira sola (§9)
                pass
            raise

    def put_manifest(self, bk: LocalBackup, mkey: str, body: bytes) -> None:
        sha_hex = hashlib.sha256(body).hexdigest()

        def do_put():
            return self.s3_upload.put_object(Bucket=self.cfg.bucket, Key=mkey, Body=body,
                                             ContentType="application/json", ContentMD5=md5_b64(body),
                                             ChecksumSHA256=sha256_b64(sha_hex))
        self.put_with_digest_retry("PutObject manifest", bk, do_put)
        h = self.head(mkey)
        if h is None or h.get("ContentLength") != len(body) or h.get("ChecksumSHA256") != sha256_b64(sha_hex):
            raise ProducerError("E-INTEGRITY-VERIFY", "HeadObject del manifiesto no coincide", self.max_attempts)

    def lifecycle(self) -> list[dict] | None:
        resp = self.call("GetBucketLifecycleConfiguration",
                         lambda: self.s3.get_bucket_lifecycle_configuration(Bucket=self.cfg.bucket), allow_404=True)
        return None if resp is None else resp.get("Rules", [])


def lifecycle_rules(rules: list[dict]) -> list[tuple]:
    return sorted(((r.get("ID"), r.get("Status"), r.get("Filter", {}).get("Prefix"),
                    r.get("Expiration", {}).get("Days"),
                    r.get("AbortIncompleteMultipartUpload", {}).get("DaysAfterInitiation")) for r in rules), key=repr)


# --- productor ---------------------------------------------------------------------

class Producer:
    def __init__(self, cfg: Config, mt, passphrase: bytes, log: Log, remote: Remote, dry_run: bool):
        self.cfg, self.mt, self.passphrase, self.log, self.remote, self.dry_run = cfg, mt, passphrase, log, remote, dry_run
        self.failed = False

    def keys_for(self, backup_id: str) -> tuple[str, str]:
        okey = self.mt.object_key(self.cfg.deployment_id, self.cfg.database, backup_id)
        return okey, self.mt.manifest_key(okey)

    def remote_complete(self, bk: LocalBackup, okey: str, mkey: str) -> bool:
        """§8.2 pasos 2 y 3: False si no hay manifiesto remoto; True si el respaldo remoto está completo
        según §5.3 frente al archivo local (reglas 1–5, MAC con la clave) y HeadObject coincide;
        E-REMOTE-CONFLICT en cualquier otro caso (no se toca nada)."""
        remote_manifest = self.remote.get_json(mkey)
        if remote_manifest is None:
            return False
        errors = self.mt.verify(remote_manifest, str(bk.path), self.passphrase, mkey)
        if errors:
            raise ProducerError("E-REMOTE-CONFLICT", f"manifiesto remoto no corresponde al archivo local: {errors[0]}")
        ok, why = self.remote.object_matches(okey, bk.size, bk.sha256)
        if not ok:
            raise ProducerError("E-REMOTE-CONFLICT", why)
        return True

    def process(self, bk: LocalBackup, now: dt.datetime, listed: set[str]) -> None:
        okey, mkey = self.keys_for(bk.backup_id)
        started = time.monotonic()
        self.remote.reset_attempts()
        fields = {"backup_id": bk.backup_id, "object_key": okey}

        def done(status: str, error: str | None = None, action: str | None = None) -> None:
            fields.update(size_bytes=bk.size or None, sha256=bk.sha256 or None,
                          attempts=self.remote.max_attempts, duration_s=round(time.monotonic() - started))
            if error:
                fields["error"] = error
            if action:
                fields["action"] = action
            if status == "FAIL":
                self.failed = True
            self.log.emit(status, **fields)

        try:
            if now - bk.created_at >= UPLOAD_WINDOW:
                # §8.2: fuera de la ventana no se sube. Si hay manifiesto remoto se comprueba igual que en el
                # paso 3 (E-REMOTE-CONFLICT si no corresponde al archivo local); si no lo hay, se registra el hueco.
                if mkey not in listed:
                    try:
                        bk.verify_local()
                    except ProducerError:
                        pass
                    done("SKIPPED", "E-UPLOAD-WINDOW", "outside-24h-window")
                    return
                bk.verify_local()
                if not self.remote_complete(bk, okey, mkey):
                    done("SKIPPED", "E-UPLOAD-WINDOW", "outside-24h-window")
                return  # completo: sin línea (el reintento horario no repite respaldos ya copiados)
            bk.verify_local()  # paso 1 (E-LOCAL-INTEGRITY)
            if self.remote_complete(bk, okey, mkey):  # pasos 2 y 3
                done("OK", action="already-complete")
                return
            if self.dry_run:
                done("OK", action="dry-run")
                return
            if bk.size > SINGLE_PART_MAX:  # paso 4
                self.remote.put_object_multipart(bk, okey)
            else:
                self.remote.put_object_single(bk, okey)
            ok, why = self.remote.object_matches(okey, bk.size, bk.sha256)  # paso 5 (§8.3)
            if not ok:
                raise ProducerError("E-INTEGRITY-VERIFY", why)
            size, sha = self.remote.get_sha256(okey)
            if size != bk.size or sha != bk.sha256:
                raise ProducerError("E-INTEGRITY-VERIFY", "GetObject: el SHA-256 del cuerpo no coincide")
            manifest = self.mt.build_manifest(passphrase=self.passphrase, size=bk.size, sha256=bk.sha256,
                                              backup_id=bk.backup_id, deployment_id=self.cfg.deployment_id,
                                              database=self.cfg.database)
            body = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
            self.remote.put_manifest(bk, mkey, body)  # paso 6
            done("OK", action="uploaded")  # paso 7
        except ProducerError as exc:
            self.remote.max_attempts = max(self.remote.max_attempts, exc.attempts)
            print(f"{PRODUCER}: {bk.backup_id}: {exc}", file=sys.stderr)
            done("FAIL", exc.code)
            if exc.code in ("E-DEADLINE", "E-AUTH-SKEW", "E-AUTH-DENIED", "E-AUTH-SIGNATURE", "E-BUCKET", "E-TLS",
                            "E-NOT-IMPLEMENTED"):
                raise

    def verify_remote(self, bid: str) -> str | None:
        """§5.3 sin archivo local: manifiesto leído de su clave derivada, reglas 1, 2, 3 (key_id + MAC) y 5,
        y HeadObject del objeto (tamaño y, en una parte, x-amz-checksum-sha256). Devuelve None si el
        respaldo remoto está completo o el código §13 del defecto (E-RESTORE-MAC / E-REMOTE-CONFLICT)."""
        okey, mkey = self.keys_for(bid)
        try:
            m = self.remote.get_json(mkey)
        except ProducerError as exc:
            if exc.code == "E-REMOTE-CONFLICT":  # manifiesto ilegible
                return "E-RESTORE-MAC"
            raise
        if m is None:
            return "E-REMOTE-CONFLICT"
        if self.mt.verify(m, None, self.passphrase, mkey):
            return "E-RESTORE-MAC"
        obj = m["object"]
        if not isinstance(obj.get("size_bytes"), int) or not isinstance(obj.get("sha256"), str):
            return "E-RESTORE-MAC"
        ok, _ = self.remote.object_matches(okey, obj["size_bytes"], obj["sha256"])
        return None if ok else "E-REMOTE-CONFLICT"

    def daily_check(self, now: dt.datetime) -> None:
        """§10.1 con ListObjectsV2 sobre el prefijo de la instalación y GetBucketLifecycleConfiguration.
        «Completo» según §5.3 con la clave disponible (verify_remote), no por mera presencia del par."""
        started = time.monotonic()
        self.remote.reset_attempts()
        errors: list[str] = []
        warnings: list[str] = []
        objects = self.remote.list_prefix()
        dumps: dict[str, dt.datetime] = {}
        manifests: set[str] = set()
        unexpected = 0
        for o in objects:
            key = o["Key"]
            name = key.rsplit("/", 1)[-1]
            if name.endswith(".dump.enc"):
                bid, is_manifest = name[: -len(".dump.enc")], False
            elif name.endswith(".manifest.json"):
                bid, is_manifest = name[: -len(".manifest.json")], True
            else:
                unexpected += 1
                continue
            if not self.mt.BACKUP_ID_RE.match(bid):
                unexpected += 1
                continue
            okey, mkey = self.keys_for(bid)
            if key != (mkey if is_manifest else okey):
                unexpected += 1
                continue
            created = dt.datetime.strptime(self.mt.created_at(bid), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
            if is_manifest:
                manifests.add(bid)
            else:
                dumps[bid] = created
        invalid: dict[str, str] = {}
        for bid in sorted(manifests):
            code = self.verify_remote(bid)
            if code:
                invalid[bid] = code
        complete = sorted(b for b in manifests if b not in invalid)
        newest = complete[-1] if complete else None
        newest_age = (now - dt.datetime.strptime(self.mt.created_at(newest), "%Y-%m-%dT%H:%M:%SZ")
                      .replace(tzinfo=dt.timezone.utc)) if newest else None
        if newest_age is None or newest_age >= FRESHNESS_MAX:
            errors.append("E-FRESHNESS")
        errors += sorted(set(invalid.values()))
        all_ids = set(dumps) | manifests
        oldest = min(all_ids) if all_ids else None
        oldest_age = None
        if oldest:
            oldest_age = now - dt.datetime.strptime(self.mt.created_at(oldest), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
            if oldest_age > RETENTION_BOUND:
                errors.append("E-RETENTION-VIOLATION")
        if not (COMPLETE_RANGE[0] <= len(complete) <= COMPLETE_RANGE[1]):
            warnings.append("complete-count-out-of-range")
        orphans = sum(1 for b, c in dumps.items() if b not in manifests and now - c > ORPHAN_MAX_AGE)
        if orphans:
            warnings.append("incomplete-objects-older-than-24h")
        if unexpected:
            warnings.append("unexpected-keys")
        rules = self.remote.lifecycle()
        lifecycle_ok = rules is not None and lifecycle_rules(rules) == lifecycle_rules(LIFECYCLE_V1["Rules"])
        if not lifecycle_ok:
            errors.append("E-RETENTION-VIOLATION")
        errors = list(dict.fromkeys(errors))
        status = "FAIL" if errors else "OK"
        if errors:
            self.failed = True
        self.log.emit(status, check="daily", prefix=self.cfg.prefix, objects=len(objects), complete=len(complete),
                      newest_backup_id=newest, newest_age_h=f"{newest_age.total_seconds() / 3600:.1f}" if newest_age else None,
                      oldest_backup_id=oldest, oldest_age_d=f"{oldest_age.total_seconds() / 86400:.2f}" if oldest_age else None,
                      incomplete_over_24h=orphans, unexpected_keys=unexpected,
                      invalid=",".join(f"{b}:{c}" for b, c in sorted(invalid.items())) or None,
                      lifecycle="ok" if lifecycle_ok else ("missing" if rules is None else "differs"),
                      attempts=self.remote.max_attempts, duration_s=round(time.monotonic() - started),
                      error=",".join(errors) or None, warnings=",".join(warnings) or None)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog=PRODUCER, description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n", 2)[2])
    ap.add_argument("--check-only", action="store_true", help="solo la comprobación diaria (§10.1)")
    ap.add_argument("--dry-run", action="store_true", help="sin escrituras remotas")
    ap.add_argument("--lab-allow-http", action="store_true", help="admite http:// (solo laboratorios)")
    args = ap.parse_args(argv)

    env = dict(os.environ)
    config_path = Path(env.get("MAINSPOT_REMOTE_CONFIG") or DEFAULT_CONFIG)
    backup_dir = Path(env.get("MAINSPOT_BACKUP_DIR") or DEFAULT_BACKUP_DIR)
    log = Log(backup_dir)

    if not config_path.is_file():
        log.emit("DISABLED", reason="no-config", config=str(config_path))
        return 0
    try:
        values = parse_env_file(config_path)
    except ProducerError as exc:
        log.emit("FAIL", error=exc.code, reason=exc.detail.replace(" ", "_"))
        return 1
    except OSError as exc:
        log.emit("FAIL", error="E-CONFIG", reason=type(exc).__name__)
        return 1
    if values.get("MAINSPOT_REMOTE_BACKUP_ENABLED", "0") != "1":
        log.emit("DISABLED", reason="MAINSPOT_REMOTE_BACKUP_ENABLED!=1", config=str(config_path))
        return 0

    try:
        mt = load_manifest_tool()
        load_boto()
        cfg = Config(values, env, mt, args.lab_allow_http)
        log = Log(cfg.backup_dir)
        passphrase = mt.read_passphrase(str(cfg.key_file))
    except ImportError:
        log.emit("FAIL", error="E-CONFIG", reason="boto3>=1.36_no_disponible")
        return 2
    except ProducerError as exc:
        log.emit("FAIL", error=exc.code, reason=exc.detail.replace(" ", "_"))
        return 1
    except (OSError, ValueError, RuntimeError) as exc:
        # read_passphrase: permisos o clave vacía (su mensaje no contiene la clave)
        log.emit("FAIL", error="E-CONFIG", reason=str(exc).replace(" ", "_"))
        return 1

    if not cfg.backup_dir.is_dir():
        log.emit("FAIL", error="E-CONFIG", reason=f"no_existe_{cfg.backup_dir}")
        return 1
    lock_fd = os.open(cfg.backup_dir / ".db-backup-remote.lock", os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log.emit("FAIL", error="E-CONFIG", reason="otra_ejecucion_en_curso")
        os.close(lock_fd)
        return 1

    try:
        remote = Remote(cfg, args.dry_run)
        producer = Producer(cfg, mt, passphrase, log, remote, args.dry_run)
        now = utcnow()
        try:
            remote.head_bucket_and_clock()
            if not args.check_only:
                listed = {o["Key"] for o in remote.list_prefix()}
                for bk in discover_local(cfg.backup_dir, mt):
                    producer.process(bk, now, listed)
            producer.daily_check(now)
        except ProducerError as exc:
            print(f"{PRODUCER}: {exc}", file=sys.stderr)
            log.emit("FAIL", error=exc.code, attempts=exc.attempts,
                     skew_s=f"{remote.skew_s:.0f}" if exc.code == "E-AUTH-SKEW" and remote.skew_s is not None else None,
                     duration_s=round(time.monotonic() - remote.started))
            return 1
        return 1 if producer.failed else 0
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


if __name__ == "__main__":
    sys.exit(main())
