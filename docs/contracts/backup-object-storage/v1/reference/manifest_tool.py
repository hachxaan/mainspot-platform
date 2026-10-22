#!/usr/bin/env python3
"""Reference implementation of the MainSpot backup manifest v1 (CONTRACT.md sections 4, 5 and 7).

Standard library only (Python >= 3.10). Optional: `jsonschema` for full schema validation.

    manifest_tool.py object-key --deployment-id D --database DB --backup-id ID
    manifest_tool.py key-id --key KEYFILE
    manifest_tool.py build --key KEYFILE --object FILE --deployment-id D --database DB \\
        [--backup-id ID] [--toc-entries N] [--server-version V] [--archive-version V]
    manifest_tool.py verify --manifest FILE [--manifest-key KEY] [--object FILE] [--key KEYFILE]
    manifest_tool.py selftest

KEYFILE is the backup key file used with `openssl enc -pass file:KEYFILE`: its first
line without the final "\\n" is the passphrase (a "\\r" before it is kept, as OpenSSL
does). The passphrase is never printed. `--manifest-key` is the S3 key the manifest
was read from (CONTRACT.md section 5.3, rule 5).

Exit codes: 0 valid; 1 invalid or malformed manifest, object or MAC (reasons on
stderr); 2 usage error or unreadable input (missing file, key file permissions).
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import stat
import sys

SCHEMA = "mainspot-backup-manifest/v1"
CONTRACT_VERSION = "1.0.0"
SCHEME = "openssl-enc-aes-256-cbc-pbkdf2-sha256-600000/v1"
MAC_INPUT = "mainspot-backup-manifest-mac/v1"
HKDF_SALT = b"mainspot-backup/v1"
BACKUP_ID_RE = re.compile(r"^mainspot-db-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z\Z")
DEPLOYMENT_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\Z")
DATABASE_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}\Z")
OPENSSL_MAGIC = b"Salted__"

# Frozen test vector (CONTRACT.md section 7.5). The passphrase is public and test-only.
TV_PASSPHRASE = b"TEST-VECTOR-ONLY-not-a-real-key-0123456789abcdefghijklmnopqrstuv"
TV_OBJECT = OPENSSL_MAGIC + bytes(range(8)) + b"\x00" * 48
TV_BACKUP_ID = "mainspot-db-20261022T061958Z"
TV_DEPLOYMENT = "mainspot-pilot"
TV_DATABASE = "mainspot"
TV_KEY_ID = "msbk1-4bf859a355f2abcf"
TV_MAC = "dd6e517b7a3714c5801655fd0f458c6feae92eb16bf84763bf74a15d4f3e065a"


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """RFC 5869 HKDF with SHA-256."""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def read_passphrase(path: str) -> bytes:
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        raise ValueError(f"{path}: permissions too open ({oct(mode)}); require 0600 or stricter")
    with open(path, "rb") as fh:
        first = fh.readline().removesuffix(b"\n")
    if not first:
        raise ValueError(f"{path}: empty passphrase")
    return first


def key_id(passphrase: bytes) -> str:
    return "msbk1-" + hkdf_sha256(passphrase, HKDF_SALT, b"key-id").hex()[:16]


def mac_key(passphrase: bytes) -> bytes:
    return hkdf_sha256(passphrase, HKDF_SALT, b"manifest-mac")


def created_at(backup_id: str) -> str:
    m = BACKUP_ID_RE.match(backup_id)
    if not m:
        raise ValueError(f"invalid backup_id {backup_id!r}")
    y, mo, d, h, mi, s = m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{s}Z"


def object_key(deployment_id: str, database: str, backup_id: str) -> str:
    if not DEPLOYMENT_RE.match(deployment_id):
        raise ValueError(f"invalid deployment_id {deployment_id!r}")
    if not DATABASE_RE.match(database):
        raise ValueError(f"invalid database {database!r}")
    m = BACKUP_ID_RE.match(backup_id)
    if not m:
        raise ValueError(f"invalid backup_id {backup_id!r}")
    y, mo, d = m.groups()[:3]
    return f"v1/{deployment_id}/postgres/{database}/{y}/{mo}/{d}/{backup_id}.dump.enc"


def manifest_key(obj_key: str) -> str:
    return obj_key[: -len(".dump.enc")] + ".manifest.json"


def mac_input(m: dict) -> bytes:
    fields = [
        MAC_INPUT, m["backup_id"], m["deployment_id"], m["created_at"],
        m["object"]["key"], str(m["object"]["size_bytes"]), m["object"]["sha256"],
        m["encryption"]["scheme"], m["encryption"]["key_id"],
    ]
    for f in fields:
        if "\n" in f:
            raise ValueError("newline inside a MAC field")
    return ("\n".join(fields) + "\n").encode("utf-8")


def compute_mac(m: dict, passphrase: bytes) -> str:
    return hmac.new(mac_key(passphrase), mac_input(m), hashlib.sha256).hexdigest()


def file_digest(path: str) -> tuple[int, str]:
    h, size = hashlib.sha256(), 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return size, h.hexdigest()


def build_manifest(*, passphrase: bytes, size: int, sha256: str, backup_id: str, deployment_id: str,
                   database: str, source_extra: dict | None = None) -> dict:
    m: dict = {
        "schema": SCHEMA,
        "contract_version": CONTRACT_VERSION,
        "backup_id": backup_id,
        "deployment_id": deployment_id,
        "created_at": created_at(backup_id),
        "source": {"engine": "postgresql", "database": database, "dump_format": "pg_dump-custom", **(source_extra or {})},
        "encryption": {"scheme": SCHEME, "key_id": key_id(passphrase)},
        "object": {"key": object_key(deployment_id, database, backup_id), "size_bytes": size, "sha256": sha256},
        "retention": {"days": 14, "policy": "DEC-0026"},
        "producer": {"name": "mainspot-backup-remote", "version": CONTRACT_VERSION},
        "authenticity": {"alg": "HMAC-SHA256", "kdf": "HKDF-SHA256", "input": MAC_INPUT, "mac": ""},
    }
    m["authenticity"]["mac"] = compute_mac(m, passphrase)
    return m


def structural_errors(m: dict) -> list[str]:
    """Schema validation (jsonschema if installed) plus the cross-field rules of section 5.3."""
    errors: list[str] = []
    schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "manifest.schema.json")
    try:
        import jsonschema  # type: ignore[import-not-found]
        with open(schema_path, encoding="utf-8") as fh:
            schema = json.load(fh)
        errors += [f"schema: {e.message}" for e in jsonschema.Draft202012Validator(schema).iter_errors(m)]
    except ImportError:
        for k in ("schema", "contract_version", "backup_id", "deployment_id", "created_at", "encryption", "object", "authenticity"):
            if k not in m:
                errors.append(f"schema: missing {k}")
        if m.get("schema") != SCHEMA:
            errors.append("schema: wrong schema id")
    if errors:
        return errors
    try:
        if m["created_at"] != created_at(m["backup_id"]):
            errors.append("created_at does not match backup_id")
        db = m.get("source", {}).get("database", "mainspot")
        if m["object"]["key"] != object_key(m["deployment_id"], db, m["backup_id"]):
            errors.append("object.key does not match deployment_id/database/backup_id")
    except ValueError as exc:
        errors.append(str(exc))
    return errors


def verify(m: dict, object_path: str | None, passphrase: bytes | None,
           stored_manifest_key: str | None = None) -> list[str]:
    try:
        errors = structural_errors(m)
        if errors:
            return errors
        if stored_manifest_key is not None and stored_manifest_key != manifest_key(m["object"]["key"]):
            errors.append("manifest stored under a key that does not match object.key (section 5.3 rule 5)")
        if object_path:
            size, sha = file_digest(object_path)
            if size != m["object"]["size_bytes"]:
                errors.append(f"size mismatch: object {size} != manifest {m['object']['size_bytes']}")
            if sha != m["object"]["sha256"]:
                errors.append("sha256 mismatch between object and manifest")
            with open(object_path, "rb") as fh:
                if fh.read(8) != OPENSSL_MAGIC:
                    errors.append("object does not start with the OpenSSL 'Salted__' header")
        if passphrase is not None:
            if m["encryption"]["key_id"] != key_id(passphrase):
                errors.append("key_id does not match the provided key (wrong key or rotated key)")
            elif not hmac.compare_digest(m["authenticity"]["mac"], compute_mac(m, passphrase)):
                errors.append("authenticity MAC mismatch: manifest altered or not produced with this key")
        return errors
    except (TypeError, KeyError, AttributeError, ValueError) as exc:
        return [f"malformed manifest: {type(exc).__name__}: {exc}"]


def selftest() -> int:
    size, sha = len(TV_OBJECT), hashlib.sha256(TV_OBJECT).hexdigest()
    m = build_manifest(passphrase=TV_PASSPHRASE, size=size, sha256=sha, backup_id=TV_BACKUP_ID,
                       deployment_id=TV_DEPLOYMENT, database=TV_DATABASE)
    swapped = {**m, "object": {**m["object"], "sha256": "0" * 64}}  # structurally valid; only the MAC can catch it
    other_key = verify(m, None, TV_PASSPHRASE[:-1] + b"w")
    relocated_key = "v1/mainspot-pilot/postgres/mainspot/2026/10/23/mainspot-db-20261023T061958Z.manifest.json"
    checks = {
        "key_id": m["encryption"]["key_id"] == TV_KEY_ID,
        "mac": m["authenticity"]["mac"] == TV_MAC,
        "structure": not structural_errors(m),
        "valid_with_key": not verify(m, None, TV_PASSPHRASE, manifest_key(m["object"]["key"])),
        "swapped_digest_rejected_by_mac": any("MAC" in e for e in verify(swapped, None, TV_PASSPHRASE)),
        "other_key_rejected": any("key_id" in e for e in other_key),
        "relocated_manifest_rejected": any("rule 5" in e for e in verify(m, None, TV_PASSPHRASE, relocated_key)),
        "newline_in_deployment_rejected": bool(verify({**m, "deployment_id": TV_DEPLOYMENT + "\n"}, None, None)),
    }
    print(json.dumps({"key_id": m["encryption"]["key_id"], "mac": m["authenticity"]["mac"],
                      "object_sha256": sha, "object_size": size, "checks": checks}, indent=2))
    return 0 if all(checks.values()) else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="MainSpot backup manifest v1 reference tool")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("object-key")
    p.add_argument("--deployment-id", required=True)
    p.add_argument("--database", required=True)
    p.add_argument("--backup-id", required=True)
    p = sub.add_parser("key-id")
    p.add_argument("--key", required=True)
    p = sub.add_parser("build")
    p.add_argument("--key", required=True)
    p.add_argument("--object", required=True)
    p.add_argument("--deployment-id", required=True)
    p.add_argument("--database", required=True)
    p.add_argument("--backup-id", help="default: object file name without .dump.enc")
    p.add_argument("--toc-entries", type=int)
    p.add_argument("--server-version")
    p.add_argument("--archive-version")
    p = sub.add_parser("verify")
    p.add_argument("--manifest", required=True)
    p.add_argument("--manifest-key", help="S3 key the manifest was read from (rule 5)")
    p.add_argument("--object")
    p.add_argument("--key")
    sub.add_parser("selftest")
    a = ap.parse_args(argv)

    try:
        if a.cmd == "object-key":
            print(object_key(a.deployment_id, a.database, a.backup_id))
            return 0
        if a.cmd == "key-id":
            print(key_id(read_passphrase(a.key)))
            return 0
        if a.cmd == "build":
            backup_id = a.backup_id or os.path.basename(a.object).removesuffix(".dump.enc")
            size, sha = file_digest(a.object)
            extra = {k: v for k, v in (("toc_entries", a.toc_entries), ("server_version", a.server_version),
                                       ("dump_archive_version", a.archive_version)) if v is not None}
            m = build_manifest(passphrase=read_passphrase(a.key), size=size, sha256=sha, backup_id=backup_id,
                               deployment_id=a.deployment_id, database=a.database, source_extra=extra)
            print(json.dumps(m, indent=2))
            return 0
        if a.cmd == "verify":
            passphrase = read_passphrase(a.key) if a.key else None
            with open(a.manifest, "rb") as fh:
                raw = fh.read()
            try:
                m = json.loads(raw)
                errors = verify(m, a.object, passphrase, a.manifest_key) if isinstance(m, dict) \
                    else ["malformed manifest: not a JSON object"]
            except ValueError as exc:
                errors = [f"malformed manifest: {exc}"]
            for e in errors:
                print(f"invalid: {e}", file=sys.stderr)
            if not errors:
                print(json.dumps({"valid": True, "backup_id": m["backup_id"], "object_checked": bool(a.object),
                                  "mac_checked": bool(a.key), "storage_key_checked": bool(a.manifest_key)}))
            return 1 if errors else 0
        return selftest()
    except (ValueError, OSError) as exc:
        print(f"usage error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
