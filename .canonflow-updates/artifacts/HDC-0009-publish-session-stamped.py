"""HDC-0009 mitigation: `canonflow-hdc publish-session` with generated_at stamped
at publication time. Use only until the CanonFlow pin includes
patches/HDC-0009-publish-session-generated-at.patch.

    PYTHONPATH=<canonflow-keystone>/decision-console/app \\
        python HDC-0009-publish-session-stamped.py --project <root> --input <qs.json>

Same CLI semantics as `canonflow_hdc.cli publish-session`: on success prints
the same JSON result (exit 0); a LifecycleError prints
{"error": {"code", "message"}} (exit 1); a bad project or input exits 2.
Before publishing, an input generated_at later than now + 120 s is refused
(GENERATED_AT_FUTURE); otherwise generated_at is replaced by the current UTC
time (RFC 3339, seconds), so `latest` reflects the real publication order.
The input file is never modified.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

from canonflow_hdc import lifecycle
from canonflow_hdc.cli import _load_input, _project

FUTURE_TOLERANCE_S = 120


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="HDC-0009-publish-session-stamped")
    parser.add_argument("--project", required=True)
    parser.add_argument("--input", required=True)
    args = parser.parse_args(argv)
    root = _project(args)
    doc = _load_input(args.input)

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    declared = doc.get("generated_at")
    if declared is not None:
        try:
            when = dt.datetime.fromisoformat(declared) if isinstance(declared, str) else None
        except ValueError:
            when = None
        if when is not None and when.tzinfo is None:
            when = when.replace(tzinfo=dt.timezone.utc)
        if when is not None and (when - now).total_seconds() > FUTURE_TOLERANCE_S:
            print(json.dumps({"error": {
                "code": "GENERATED_AT_FUTURE",
                "message": f"generated_at {declared} is later than the publication clock "
                           f"({now.strftime('%Y-%m-%dT%H:%M:%SZ')}, tolerance "
                           f"{FUTURE_TOLERANCE_S}s); nothing was published"}}))
            return 1
    doc["generated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        result = lifecycle.publish_session(root, doc, id_hint=doc.get("question_session_id"))
    except lifecycle.LifecycleError as exc:
        print(json.dumps({"error": {"code": exc.code, "message": str(exc)}}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
