#!/usr/bin/env python3
"""Conformance check of an S3 service against the MainSpot backup object-storage
contract v1 (docs/contracts/backup-object-storage/v1/CONTRACT.md, section 14).

Run it from a host OUTSIDE the service VPS that can reach the endpoint on ports 80,
443, 3900, 3901, 3902 and 3903. It only writes objects under `_conformance/<run-id>/` and
deletes them at the end. It does not change the bucket configuration, with one
exception: if the restore key wrongly has write access, C-14 can only (re)write the
exact section 9.1 rules (C-15 runs first, so a previously different configuration is
still reported). The same applies to the guard bucket in C-21: the writer key must be
denied; if it is wrongly allowed, the probe object is deleted again and the lifecycle
submitted is the one the restore key read (or, when the guard bucket has no lifecycle,
the probe is `DeleteBucketLifecycle`; when nobody could read it, the section 9.2.4
reference rule is submitted).
It never prints access keys, secret keys, signatures or Authorization headers.

Requirements: Python >= 3.10 and boto3 >= 1.36 (`pip install 'boto3>=1.36'`).

Credentials are read from files (mode 0600 or stricter) with two lines:
    AWS_ACCESS_KEY_ID=...
    AWS_SECRET_ACCESS_KEY=...
The service's own file format (`S3_ACCESS_KEY_ID=` / `S3_SECRET_ACCESS_KEY=`, with
optional `S3_ENDPOINT`/`S3_REGION` lines that are ignored) is accepted as well.

Usage:
    python3 check_s3_backup_contract.py \\
        --writer-credentials /path/backup-writer.env \\
        --restore-credentials /path/backup-restore.env \\
        [--endpoint https://s3.mainspot.canonflow.dev] [--region garage] \\
        [--bucket mainspot-backups] [--guard-bucket mainspot-backups-guard] \\
        [--report report.json]

Protected copy (contract section 9.2): C-21 proves with the writer key that the guard
bucket is out of reach (403 on every operation). If the guard bucket does not exist as
an S3 bucket (HeadBucket 404) the result is MANUAL: either the copy is a volume outside
Garage (option B, verified by published evidence) or the name is wrong. C-22 compares,
with the restore key, the `v1/` inventory and the SHA-256 of every complete backup
between the data bucket and the guard bucket; originals older than 14 days since their
`created_at` are not required in the copy (section 9.2.4). When the restore key cannot
read the guard bucket (403/404), or when nothing could be compared (empty bucket, copies
still pending), the result is MANUAL: the correspondence must be shown by the evidence
the service publishes (section 9.2.5).

`--lab-allow-http` accepts an http:// endpoint and skips the TLS checks (C-01, C-18);
it exists only for disposable local labs and never satisfies the contract
(`"conformant": false` in the report).

Exit code: 0 when every REQUIRED check passes (PASS, WARN or MANUAL; in lab mode also
SKIP), 1 otherwise, 2 on usage errors (bad arguments, unreadable or too-open
credential files, boto3 older than 1.36).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import email.utils
import hashlib
import json
import os
import re
import socket
import ssl
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

CONTRACT = "mainspot-backup-object-storage"
CONTRACT_VERSION = "1.1.0"
DATA_PREFIX = "v1/"
CONFORMANCE_PREFIX = "_conformance/"
RETENTION_DAYS = 14
MAX_SKEW_FAIL_S = 300
MAX_SKEW_WARN_S = 30
INTERNAL_PORTS = (3900, 3901, 3902, 3903)
# Section 9.1: the exact lifecycle configuration of the bucket.
LIFECYCLE_V1 = {"Rules": [
    {"ID": "mainspot-backups-v1-retention-14d", "Status": "Enabled", "Filter": {"Prefix": DATA_PREFIX},
     "Expiration": {"Days": RETENTION_DAYS}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
    {"ID": "mainspot-backups-conformance-1d", "Status": "Enabled", "Filter": {"Prefix": CONFORMANCE_PREFIX},
     "Expiration": {"Days": 1}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
]}
# Section 9.2 (option A): reference backstop lifecycle of the guard bucket. C-21 submits
# it with the writer key only when nobody could read the current one (see c21()).
GUARD_BUCKET = "mainspot-backups-guard"
LIFECYCLE_GUARD_V1 = {"Rules": [
    {"ID": "mainspot-backups-guard-v1-retention-14d", "Status": "Enabled", "Filter": {"Prefix": DATA_PREFIX},
     "Expiration": {"Days": RETENTION_DAYS}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
]}
# Section 9.2: the copy runs hourly; a complete backup younger than this may still lack its copy.
GUARD_COPY_GRACE_S = 2 * 3600
OBJECT_SUFFIX = ".dump.enc"
MANIFEST_SUFFIX = ".manifest.json"

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover - environment check
    print("boto3 is required: pip install boto3", file=sys.stderr)
    sys.exit(2)


def load_credentials(path: str) -> tuple[str, str]:
    st = os.stat(path)
    if stat.S_IMODE(st.st_mode) & 0o077:
        raise ValueError(f"{path}: permissions too open (require 0600 or stricter)")
    values: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip().strip('"').strip("'")
    for kid, ksec in (("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"), ("S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY")):
        if values.get(kid) and values.get(ksec):
            return values[kid], values[ksec]
    raise ValueError(f"{path}: missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY)")


def client(endpoint: str, region: str, creds: tuple[str, str]):
    try:
        cfg = Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            # One HTTP request per operation: botocore's max_attempts counts retries, not requests.
            retries={"total_max_attempts": 1, "mode": "standard"},
            connect_timeout=10,
            read_timeout=120,
            # Contract §6.3/§8.4: no flexible-checksum trailers; explicit Content-MD5 and x-amz-checksum-sha256.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        )
    except TypeError as exc:
        raise ValueError("boto3/botocore >= 1.36 is required (request_checksum_calculation)") from exc
    return boto3.client("s3", endpoint_url=endpoint, region_name=region,
                        aws_access_key_id=creds[0], aws_secret_access_key=creds[1], config=cfg)


def lifecycle_rules(rules: list[dict]) -> list[tuple]:
    return sorted(((r.get("ID"), r.get("Status"), r.get("Filter", {}).get("Prefix"),
                    r.get("Expiration", {}).get("Days"),
                    r.get("AbortIncompleteMultipartUpload", {}).get("DaysAfterInitiation")) for r in rules), key=repr)


def md5_b64(data: bytes) -> str:
    return base64.b64encode(hashlib.md5(data).digest()).decode()


def err_code(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        e = exc.response.get("Error", {})
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return f"{status}:{e.get('Code', '?')}"
    return type(exc).__name__


class Report:
    def __init__(self) -> None:
        self.results: list[dict] = []

    def add(self, cid: str, required: bool, status: str, detail: str) -> None:
        self.results.append({"id": cid, "required": required, "status": status, "detail": detail})
        print(f"{status:<6} {cid} {detail}")

    def ok(self, allow_skip: bool = False) -> bool:
        # MANUAL: the check could not be executed by this script and must be covered by
        # published evidence (section 9.2); it does not block conformance by itself.
        accepted = ("PASS", "WARN", "MANUAL", "SKIP") if allow_skip else ("PASS", "WARN", "MANUAL")
        return all(r["status"] in accepted for r in self.results if r["required"])

    def manual(self) -> list[str]:
        return [r["id"] for r in self.results if r["status"] == "MANUAL"]


def check(report: Report, cid: str, required: bool, fn) -> None:
    try:
        status, detail = fn()
    except Exception as exc:  # noqa: BLE001 - every failure is reported, never raised
        status, detail = "FAIL", f"unexpected {err_code(exc)}"
    report.add(cid, required, status, detail)


def expect_denied(fn, codes=("403",)) -> tuple[str, str]:
    try:
        fn()
    except ClientError as exc:
        code = err_code(exc)
        if code.split(":")[0] in codes:
            return "PASS", f"denied as required ({code})"
        return "FAIL", f"expected {'/'.join(codes)}, got {code}"
    return "FAIL", "operation succeeded but must be denied"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--endpoint", default="https://s3.mainspot.canonflow.dev")
    ap.add_argument("--region", default="garage")
    ap.add_argument("--bucket", default="mainspot-backups")
    ap.add_argument("--guard-bucket", default=GUARD_BUCKET,
                    help="S3 bucket of the protected copy (section 9.2, option A); C-21/C-22")
    ap.add_argument("--guard-copy-grace", type=int, default=GUARD_COPY_GRACE_S, metavar="SECONDS",
                    help="C-22: a complete backup younger than this may still lack its protected copy")
    ap.add_argument("--writer-credentials", required=True)
    ap.add_argument("--restore-credentials", required=True)
    ap.add_argument("--report")
    ap.add_argument("--lab-allow-http", action="store_true")
    args = ap.parse_args(argv)

    url = urllib.parse.urlsplit(args.endpoint)
    if url.scheme != "https" and not args.lab_allow_http:
        print("endpoint must be https:// (contract §6.1)", file=sys.stderr)
        return 2
    try:
        writer = client(args.endpoint, args.region, load_credentials(args.writer_credentials))
        restore = client(args.endpoint, args.region, load_credentials(args.restore_credentials))
    except (OSError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 2
    bucket = args.bucket
    run = f"{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
    base = f"{CONFORMANCE_PREFIX}{run}/"
    report = Report()
    started = dt.datetime.now(dt.timezone.utc)

    # C-01 / C-18: transport security (skipped only in labs).
    def c01():
        ctx = ssl.create_default_context()
        port = url.port or 443
        with socket.create_connection((url.hostname, port), timeout=10) as sock:
            with ctx.wrap_socket(sock, server_hostname=url.hostname) as tls:
                version = tls.version()
                cert = tls.getpeercert()
        not_after = dt.datetime.fromtimestamp(ssl.cert_time_to_seconds(cert["notAfter"]), dt.timezone.utc)
        days = (not_after - dt.datetime.now(dt.timezone.utc)).days
        if version not in ("TLSv1.2", "TLSv1.3"):
            return "FAIL", f"negotiated {version}"
        if days < 14:
            return "WARN", f"{version}; certificate valid for {url.hostname}, expires in {days} days"
        return "PASS", f"{version}; publicly trusted certificate valid for {url.hostname}, {days} days left"

    def c18():
        plain = urllib.parse.urlunsplit(("http", url.hostname, f"/{bucket}/", "", ""))
        req = urllib.request.Request(plain, method="GET")

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            resp = opener.open(req, timeout=10)
            return "FAIL", f"plain HTTP answered {resp.status}; S3 must only be served over HTTPS"
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 307, 308) and str(exc.headers.get("Location", "")).startswith("https://"):
                return "PASS", f"plain HTTP redirects to HTTPS ({exc.code}) without serving S3"
            return "FAIL", f"plain HTTP answered {exc.code}; expected closed port or redirect to https"
        except (urllib.error.URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, socket.gaierror):
                return "FAIL", f"cannot resolve {url.hostname} ({reason}); the check is inconclusive"
            return "PASS", f"plain HTTP not served ({type(reason).__name__})"

    def c20():
        open_ports = []
        for port in INTERNAL_PORTS:
            try:
                with socket.create_connection((url.hostname, port), timeout=5):
                    open_ports.append(port)
            except socket.gaierror as exc:
                return "FAIL", f"cannot resolve {url.hostname} ({exc}); the check is inconclusive"
            except OSError:
                pass
        return ("FAIL", f"internal Garage ports reachable from outside: {open_ports}") if open_ports \
            else ("PASS", f"ports {list(INTERNAL_PORTS)} not reachable (run from outside the service VPS)")

    if args.lab_allow_http:
        report.add("C-01", True, "SKIP", "lab mode: TLS not checked (does not satisfy the contract)")
        report.add("C-18", True, "SKIP", "lab mode: plain-HTTP exposure not checked")
        report.add("C-20", True, "SKIP", "lab mode: internal port exposure not checked")
    else:
        check(report, "C-01", True, c01)
        check(report, "C-18", True, c18)
        check(report, "C-20", True, c20)

    # C-02: clock skew from the server Date header.
    def c02():
        resp = writer.head_bucket(Bucket=bucket)
        date = resp["ResponseMetadata"]["HTTPHeaders"].get("date")
        if not date:
            return "FAIL", "no Date header"
        skew = abs((email.utils.parsedate_to_datetime(date) - dt.datetime.now(dt.timezone.utc)).total_seconds())
        if skew > MAX_SKEW_FAIL_S:
            return "FAIL", f"clock skew {skew:.0f}s > {MAX_SKEW_FAIL_S}s"
        return ("WARN" if skew > MAX_SKEW_WARN_S else "PASS"), f"clock skew {skew:.0f}s"
    check(report, "C-02", True, c02)

    # C-03 / C-04: SigV4, region and path-style for both MainSpot keys.
    check(report, "C-03", True, lambda: (writer.head_bucket(Bucket=bucket), ("PASS", "writer key: HeadBucket OK (SigV4, path-style)"))[1])
    check(report, "C-04", True, lambda: (restore.head_bucket(Bucket=bucket), ("PASS", "restore key: HeadBucket OK"))[1])

    small = os.urandom(64 * 1024)
    small_sha = hashlib.sha256(small).hexdigest()
    small_key = base + "small.bin"

    def c05():
        resp = writer.put_object(Bucket=bucket, Key=small_key, Body=small, ContentMD5=md5_b64(small),
                                 ContentType="application/octet-stream", Metadata={"sha256": small_sha})
        return "PASS", f"PutObject with Content-MD5 accepted (ETag {resp.get('ETag', '?')})"
    check(report, "C-05", True, c05)

    def c06():
        bad_key = base + "bad-digest.bin"
        try:
            writer.put_object(Bucket=bucket, Key=bad_key, Body=small, ContentMD5=md5_b64(small + b"x"))
        except ClientError as exc:
            code = err_code(exc)
            try:
                writer.head_object(Bucket=bucket, Key=bad_key)
                return "FAIL", f"rejected ({code}) but the object exists"
            except ClientError as head_exc:
                if not err_code(head_exc).startswith("404"):
                    return "FAIL", f"rejected ({code}) but HEAD returned {err_code(head_exc)}, expected 404"
                return ("PASS", f"wrong Content-MD5 rejected ({code}); nothing stored") if code.startswith("400") \
                    else ("FAIL", f"rejected with {code}; expected 400 BadDigest/InvalidDigest")
        return "FAIL", "wrong Content-MD5 accepted"
    check(report, "C-06", True, c06)

    def c19():
        key = base + "checksum.bin"
        sha_b64 = base64.b64encode(hashlib.sha256(small).digest()).decode()
        writer.put_object(Bucket=bucket, Key=key, Body=small, ContentMD5=md5_b64(small), ChecksumSHA256=sha_b64)
        head = restore.head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
        if head.get("ChecksumSHA256") != sha_b64:
            return "FAIL", "HeadObject (x-amz-checksum-mode: ENABLED) does not return the stored SHA-256"
        wrong = base64.b64encode(hashlib.sha256(b"wrong").digest()).decode()
        try:
            writer.put_object(Bucket=bucket, Key=base + "checksum-bad.bin", Body=small, ChecksumSHA256=wrong)
        except ClientError as exc:
            code = err_code(exc)
            return ("PASS", f"x-amz-checksum-sha256 verified on upload (wrong value: {code}) and returned by HeadObject") \
                if code.startswith("400") else ("FAIL", f"wrong x-amz-checksum-sha256 rejected with {code}; expected 400")
        return "FAIL", "wrong x-amz-checksum-sha256 accepted"
    check(report, "C-19", True, c19)

    def c07():
        h = restore.head_object(Bucket=bucket, Key=small_key)
        if h["ContentLength"] != len(small):
            return "FAIL", f"ContentLength {h['ContentLength']} != {len(small)}"
        if h.get("Metadata", {}).get("sha256") != small_sha:
            return "FAIL", "x-amz-meta-sha256 not preserved"
        return "PASS", "HeadObject: size and x-amz-meta-sha256 preserved"
    check(report, "C-07", True, c07)

    def c08():
        body = restore.get_object(Bucket=bucket, Key=small_key)["Body"].read()
        return ("PASS", "GetObject bytes identical (SHA-256)") if hashlib.sha256(body).hexdigest() == small_sha \
            else ("FAIL", "GetObject bytes differ")
    check(report, "C-08", True, c08)

    def c09():
        lp = base + "list/"
        for i in range(3):
            data = f"object {i}".encode()
            writer.put_object(Bucket=bucket, Key=f"{lp}{i:02d}.bin", Body=data, ContentMD5=md5_b64(data))
        seen, token, pages = [], None, 0
        while True:
            kw = {"Bucket": bucket, "Prefix": lp, "MaxKeys": 2}
            if token:
                kw["ContinuationToken"] = token
            page = restore.list_objects_v2(**kw)
            pages += 1
            seen += [o["Key"] for o in page.get("Contents", [])]
            if not page.get("IsTruncated"):
                break
            token = page["NextContinuationToken"]
        expected = [f"{lp}{i:02d}.bin" for i in range(3)]
        if seen != expected or pages < 2:
            return "FAIL", f"listing returned {len(seen)} keys in {pages} pages"
        return "PASS", "ListObjectsV2 prefix + MaxKeys + ContinuationToken: 3 keys in lexicographic order, 2 pages"
    check(report, "C-09", True, c09)

    def c10():
        key = base + "multipart.bin"
        parts_data = [os.urandom(8 * 1024 * 1024), os.urandom(1024 * 1024)]
        up = writer.create_multipart_upload(Bucket=bucket, Key=key, Metadata={"sha256": hashlib.sha256(b"".join(parts_data)).hexdigest()})
        parts = []
        try:
            for n, data in enumerate(parts_data, start=1):
                r = writer.upload_part(Bucket=bucket, Key=key, UploadId=up["UploadId"], PartNumber=n,
                                       Body=data, ContentMD5=md5_b64(data))
                parts.append({"PartNumber": n, "ETag": r["ETag"]})
            writer.complete_multipart_upload(Bucket=bucket, Key=key, UploadId=up["UploadId"],
                                             MultipartUpload={"Parts": parts})
        except Exception:
            writer.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=up["UploadId"])
            raise
        body = restore.get_object(Bucket=bucket, Key=key)["Body"].read()
        ok = hashlib.sha256(body).digest() == hashlib.sha256(b"".join(parts_data)).digest()
        return ("PASS", "multipart (8 MiB + 1 MiB, Content-MD5 per part) complete; bytes identical") if ok \
            else ("FAIL", "multipart object differs")
    check(report, "C-10", True, c10)

    def c11():
        key = base + "aborted.bin"
        up = writer.create_multipart_upload(Bucket=bucket, Key=key)
        data = os.urandom(1024 * 1024)
        writer.upload_part(Bucket=bucket, Key=key, UploadId=up["UploadId"], PartNumber=1, Body=data, ContentMD5=md5_b64(data))
        writer.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=up["UploadId"])
        pending = writer.list_multipart_uploads(Bucket=bucket, Prefix=key).get("Uploads", [])
        if any(u["UploadId"] == up["UploadId"] for u in pending):
            return "FAIL", "aborted upload still listed"
        return "PASS", "AbortMultipartUpload removes the pending upload"
    check(report, "C-11", True, c11)

    def c15():
        # Garage maps lifecycle reads to the read permission: the restore key can show it.
        rules = restore.get_bucket_lifecycle_configuration(Bucket=bucket)["Rules"]
        got, want = lifecycle_rules(rules), lifecycle_rules(LIFECYCLE_V1["Rules"])
        if got != want:
            return "FAIL", f"lifecycle differs from section 9.1: got {got}, want {want}"
        return "PASS", (f"lifecycle exactly as section 9.1: {DATA_PREFIX} {RETENTION_DAYS} days, "
                        f"{CONFORMANCE_PREFIX} 1 day, incomplete uploads aborted after 1 day")
    # C-15 runs before C-14 so that C-14 can never hide a different configuration.
    check(report, "C-15", True, c15)

    check(report, "C-12", True, lambda: expect_denied(lambda: restore.put_object(
        Bucket=bucket, Key=base + "denied.bin", Body=b"x", ContentMD5=md5_b64(b"x"))))
    check(report, "C-13", True, lambda: expect_denied(lambda: restore.delete_object(Bucket=bucket, Key=small_key)))
    # C-14 submits the exact section 9.1 configuration: if the key wrongly has write access, the
    # bucket still ends with the contract lifecycle (the check then fails).
    check(report, "C-14", True, lambda: expect_denied(lambda: restore.put_bucket_lifecycle_configuration(
        Bucket=bucket, LifecycleConfiguration=LIFECYCLE_V1)))

    # C-21 / C-22: protected copy (section 9.2).
    guard_bucket = args.guard_bucket

    def list_all(cli, bkt: str, prefix: str) -> dict[str, dict]:
        objs, token = {}, None
        while True:
            kw = {"Bucket": bkt, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            page = cli.list_objects_v2(**kw)
            for o in page.get("Contents", []):
                objs[o["Key"]] = o
            if not page.get("IsTruncated"):
                break
            token = page["NextContinuationToken"]
        return objs

    def c21():
        try:
            writer.head_bucket(Bucket=guard_bucket)
            head = "HeadBucket allowed"
        except ClientError as exc:
            code = err_code(exc)
            if code.startswith("404"):
                return "MANUAL", (f"no guard bucket {guard_bucket!r} in S3 (HeadBucket {code}): either the protected "
                                  "copy is not an S3 bucket (section 9.2, option B) or the name is wrong; the absence "
                                  "of any path from the writer key must be shown by the published evidence of section 9.2.5")
            head = None if code.startswith("403") else f"HeadBucket {code}"
        # The lifecycle probe must not leave the guard bucket in another state if the writer is
        # wrongly authorised: it submits the configuration currently in place (read by the restore
        # key, option A'); when the guard bucket has no lifecycle, the probe is DeleteBucketLifecycle
        # (nothing to overwrite); when nobody could read it, the section 9.2.4 reference rule.
        try:
            guard_lc = {"Rules": restore.get_bucket_lifecycle_configuration(Bucket=guard_bucket)["Rules"]}
        except ClientError as exc:
            guard_lc = None if "NoSuchLifecycleConfiguration" in err_code(exc) else LIFECYCLE_GUARD_V1
        if guard_lc is None:
            lifecycle_probe = ("DeleteBucketLifecycle", lambda: writer.delete_bucket_lifecycle(Bucket=guard_bucket))
        else:
            lifecycle_probe = ("PutBucketLifecycleConfiguration", lambda: writer.put_bucket_lifecycle_configuration(
                Bucket=guard_bucket, LifecycleConfiguration=guard_lc))
        probe_key = base + "guard-probe.bin"
        left: list[str] = []

        def put_probe():
            writer.put_object(Bucket=guard_bucket, Key=probe_key, Body=b"x", ContentMD5=md5_b64(b"x"))
            try:  # the writer must never leave anything in the guard bucket
                writer.delete_object(Bucket=guard_bucket, Key=probe_key)
            except ClientError as exc:
                left.append(f"probe object left in guard bucket: {probe_key} (DeleteObject {err_code(exc)})")
        probes = [
            ("ListObjectsV2", lambda: writer.list_objects_v2(Bucket=guard_bucket, MaxKeys=1)),
            ("PutObject", put_probe),
            ("DeleteObject", lambda: writer.delete_object(Bucket=guard_bucket, Key=probe_key)),
            lifecycle_probe,
        ]
        allowed = [head] if head else []
        for name, fn in probes:
            status, detail = expect_denied(fn)
            if status != "PASS":
                allowed.append(f"{name}: {detail}")
        if allowed:
            return "FAIL", f"writer key reaches the guard bucket {guard_bucket!r}: " + "; ".join(allowed + left)
        return "PASS", (f"writer key denied (403) on guard bucket {guard_bucket!r}: HeadBucket, ListObjectsV2, "
                        f"PutObject, DeleteObject, {lifecycle_probe[0]}")
    check(report, "C-21", True, c21)

    def sha256_of(cli, bkt: str, key: str, size: int) -> str:
        head = cli.head_object(Bucket=bkt, Key=key, ChecksumMode="ENABLED")
        if head["ContentLength"] != size:
            return f"size:{head['ContentLength']}"
        checksum = head.get("ChecksumSHA256", "")
        # A multipart object's checksum is a composite of the part checksums, not the SHA-256 of
        # the body: AWS marks it `…-N`; Garage v2.4.1 omits the suffix but keeps it on the ETag.
        multipart = "-" in checksum or re.search(r'-\d+"?$', head.get("ETag", "")) is not None
        if checksum and not multipart:
            return base64.b64decode(checksum).hex()
        h = hashlib.sha256()
        for chunk in cli.get_object(Bucket=bkt, Key=key)["Body"].iter_chunks(1024 * 1024):
            h.update(chunk)
        return h.hexdigest()

    def c22():
        try:
            restore.head_bucket(Bucket=guard_bucket)
        except ClientError as exc:
            code = err_code(exc)
            if code.startswith("404"):
                return "MANUAL", (f"no guard bucket {guard_bucket!r} in S3 ({code}): copy/original correspondence "
                                  "must be shown by the published evidence of the service (section 9.2, option B)")
            if code.startswith("403"):
                return "MANUAL", (f"restore key cannot read the guard bucket {guard_bucket!r} ({code}): "
                                  "correspondence must be shown by published evidence (section 9.2, option A without A')")
            raise
        originals = list_all(restore, bucket, DATA_PREFIX)
        copies = list_all(restore, guard_bucket, DATA_PREFIX)
        now = dt.datetime.now(dt.timezone.utc)
        complete = [k for k in originals if k.endswith(OBJECT_SUFFIX)
                    and k[:-len(OBJECT_SUFFIX)] + MANIFEST_SUFFIX in originals]
        missing, pending, mismatch, checked, aged = [], [], [], 0, 0
        for obj_key in sorted(complete):
            man_key = obj_key[:-len(OBJECT_SUFFIX)] + MANIFEST_SUFFIX
            age = (now - originals[man_key]["LastModified"]).total_seconds()
            m_ = re.search(r"-(\d{8}T\d{6}Z)\.dump\.enc$", obj_key)
            created = dt.datetime.strptime(m_.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc) if m_ else None
            if created and now - created >= dt.timedelta(days=RETENTION_DAYS):
                aged += 1  # the copy legitimately expired (section 9.2.4); the original goes at the next lifecycle run
                continue
            for key in (obj_key, man_key):
                if key not in copies:
                    (pending if age < args.guard_copy_grace else missing).append(key)
                    continue
                size = originals[key]["Size"]
                if copies[key]["Size"] != size:
                    mismatch.append(f"{key} (size {copies[key]['Size']} != {size})")
                    continue
                a, b = sha256_of(restore, bucket, key, size), sha256_of(restore, guard_bucket, key, size)
                checked += 1
                if a != b:
                    mismatch.append(f"{key} (sha256 differs)")
        extra = len([k for k in copies if k not in originals])
        summary = (f"{len(complete)} complete backups under {DATA_PREFIX} in {bucket!r}, {checked} objects compared "
                   f"with {guard_bucket!r} by size and SHA-256; {len(pending)} pending (< {args.guard_copy_grace} s), "
                   f"{aged} originals past {RETENTION_DAYS} d (copy expired as required), "
                   f"{extra} copies without original (deleted originals are expected to survive in the guard)")
        if missing or mismatch:
            hint = ("; a missing copy may also mean the copier rejected the manifest (section 9.2.3): validate it "
                    "with manifest_tool.py verify") if missing else ""
            return "FAIL", f"{summary}; missing copies: {missing[:5]}; mismatches: {mismatch[:5]}{hint}"
        if checked == 0:
            return "MANUAL", (f"{summary}; nothing compared: run with the synthetic pairs of section 9.2.6 present "
                              "or rely on the evidence of section 9.2.5")
        return "PASS", summary
    check(report, "C-22", True, c22)

    def c17():
        anon = urllib.parse.urlunsplit((url.scheme, url.netloc, f"/{bucket}/{urllib.parse.quote(small_key)}", "", ""))
        ctx = ssl.create_default_context() if url.scheme == "https" else None
        try:
            with urllib.request.urlopen(anon, timeout=10, context=ctx) as resp:
                return "FAIL", f"anonymous GET returned {resp.status}"
        except urllib.error.HTTPError as exc:
            return ("PASS", f"anonymous GET denied ({exc.code})") if exc.code in (401, 403) \
                else ("FAIL", f"anonymous GET returned {exc.code}; expected 403")
    check(report, "C-17", True, c17)

    def c16():
        keys, token = [], None
        while True:
            kw = {"Bucket": bucket, "Prefix": base}
            if token:
                kw["ContinuationToken"] = token
            page = writer.list_objects_v2(**kw)
            keys += [o["Key"] for o in page.get("Contents", [])]
            if not page.get("IsTruncated"):
                break
            token = page["NextContinuationToken"]
        for k in keys:
            writer.delete_object(Bucket=bucket, Key=k)
        left = writer.list_objects_v2(Bucket=bucket, Prefix=base).get("KeyCount", 0)
        return ("PASS", f"cleanup: {len(keys)} conformance objects deleted") if left == 0 \
            else ("FAIL", f"{left} conformance objects left under {base}")
    check(report, "C-16", True, c16)

    out = {
        "contract": CONTRACT, "contract_version": CONTRACT_VERSION, "endpoint": args.endpoint,
        "region": args.region, "bucket": bucket, "guard_bucket": guard_bucket, "run": run,
        "lab_mode": args.lab_allow_http,
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "conformant": report.ok() and not args.lab_allow_http,
        "manual": report.manual(),
        "results": report.results,
    }
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2)
            fh.write("\n")
    print(json.dumps({k: out[k] for k in ("contract_version", "endpoint", "run", "lab_mode", "conformant", "manual")}))
    return 0 if report.ok(allow_skip=args.lab_allow_http) else 1


if __name__ == "__main__":
    sys.exit(main())
