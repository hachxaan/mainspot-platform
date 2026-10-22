#!/usr/bin/env python3
"""Conformance check of an S3 service against the MainSpot backup object-storage
contract v1 (docs/contracts/backup-object-storage/v1/CONTRACT.md, section 14).

Run it from a host OUTSIDE the service VPS that can reach the endpoint on ports 80,
443, 3901, 3902 and 3903. It only writes objects under `_conformance/<run-id>/` and
deletes them at the end. It does not change the bucket configuration, with one
exception: if the restore key wrongly has write access, C-14 can only (re)write the
exact section 9 rules (C-15 runs first, so a previously different configuration is
still reported). It never prints access keys, secret keys, signatures or Authorization headers.

Requirements: Python >= 3.10 and boto3 >= 1.36 (`pip install 'boto3>=1.36'`).

Credentials are read from files (mode 0600 or stricter) with two lines:
    AWS_ACCESS_KEY_ID=...
    AWS_SECRET_ACCESS_KEY=...

Usage:
    python3 check_s3_backup_contract.py \\
        --writer-credentials /path/backup-writer.env \\
        --restore-credentials /path/backup-restore.env \\
        [--endpoint https://s3.mainspot.canonflow.dev] [--region garage] \\
        [--bucket mainspot-backups] [--report report.json]

`--lab-allow-http` accepts an http:// endpoint and skips the TLS checks (C-01, C-18);
it exists only for disposable local labs and never satisfies the contract
(`"conformant": false` in the report).

Exit code: 0 when every REQUIRED check passes (in lab mode: every check that was
not skipped), 1 otherwise, 2 on usage errors (bad arguments, unreadable or too-open
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
import socket
import ssl
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

CONTRACT = "mainspot-backup-object-storage"
CONTRACT_VERSION = "1.0.0"
DATA_PREFIX = "v1/"
CONFORMANCE_PREFIX = "_conformance/"
RETENTION_DAYS = 14
MAX_SKEW_FAIL_S = 300
MAX_SKEW_WARN_S = 30
INTERNAL_PORTS = (3901, 3902, 3903)
# Section 9: the exact lifecycle configuration of the bucket.
LIFECYCLE_V1 = {"Rules": [
    {"ID": "mainspot-backups-v1-retention-14d", "Status": "Enabled", "Filter": {"Prefix": DATA_PREFIX},
     "Expiration": {"Days": RETENTION_DAYS}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
    {"ID": "mainspot-backups-conformance-1d", "Status": "Enabled", "Filter": {"Prefix": CONFORMANCE_PREFIX},
     "Expiration": {"Days": 1}, "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
]}

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
    try:
        return values["AWS_ACCESS_KEY_ID"], values["AWS_SECRET_ACCESS_KEY"]
    except KeyError as exc:
        raise ValueError(f"{path}: missing {exc.args[0]}") from None


def client(endpoint: str, region: str, creds: tuple[str, str]):
    try:
        cfg = Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 1, "mode": "standard"},
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
        accepted = ("PASS", "WARN", "SKIP") if allow_skip else ("PASS", "WARN")
        return all(r["status"] in accepted for r in self.results if r["required"])


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
            return "FAIL", f"lifecycle differs from section 9: got {got}, want {want}"
        return "PASS", (f"lifecycle exactly as section 9: {DATA_PREFIX} {RETENTION_DAYS} days, "
                        f"{CONFORMANCE_PREFIX} 1 day, incomplete uploads aborted after 1 day")
    # C-15 runs before C-14 so that C-14 can never hide a different configuration.
    check(report, "C-15", True, c15)

    check(report, "C-12", True, lambda: expect_denied(lambda: restore.put_object(
        Bucket=bucket, Key=base + "denied.bin", Body=b"x", ContentMD5=md5_b64(b"x"))))
    check(report, "C-13", True, lambda: expect_denied(lambda: restore.delete_object(Bucket=bucket, Key=small_key)))
    # C-14 submits the exact section 9 configuration: if the key wrongly has write access, the
    # bucket still ends with the contract lifecycle (the check then fails).
    check(report, "C-14", True, lambda: expect_denied(lambda: restore.put_bucket_lifecycle_configuration(
        Bucket=bucket, LifecycleConfiguration=LIFECYCLE_V1)))

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
        "region": args.region, "bucket": bucket, "run": run, "lab_mode": args.lab_allow_http,
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "conformant": report.ok() and not args.lab_allow_http,
        "results": report.results,
    }
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2)
            fh.write("\n")
    print(json.dumps({k: out[k] for k in ("contract_version", "endpoint", "run", "lab_mode", "conformant")}))
    return 0 if report.ok(allow_skip=args.lab_allow_http) else 1


if __name__ == "__main__":
    sys.exit(main())
