"""HDC-0006 workaround: regenerate decision-state/index.json and latest.json with
the same derivation as `canonflow-hdc rebuild-index`, but each entry declares the
evidence-derived effective state (v2 QS always declare PENDING). Use only until
the CanonFlow pin includes patches/HDC-0006-compat-views-lifecycle.patch.

    PYTHONPATH=<canonflow-keystone>/decision-console/app \\
        python HDC-0006-regenerate-compat-views.py --run RUN-NNNN [--project <root>]

--run is recorded in index.json `reconstructed.by`. --project defaults to the
current directory. Exit 0 on success. Exit 1 (validation or write failure) or 2
(bad arguments) with an `error:` line on stderr; validation runs before writing,
so a failed validation leaves index.json/latest.json untouched (the legacy
snapshot of their current bytes may already have been captured).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

from canonflow_hdc import identity, paths, profiles
from canonflow_hdc.artifacts import inventory
from canonflow_hdc.legacy import preserve_legacy_indexes
from canonflow_hdc.reconcile import reconcile

RECORD_COUNTERS = {'DEC': 'dec', 'APR': 'apr', 'RSK': 'rsk'}


class RegenerationError(Exception):
    pass


def regenerate(root: Path, run: str) -> None:
    now = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    preserve_legacy_indexes(root)
    rec = reconcile(root)
    if not rec.sessions:
        raise RegenerationError('no question sessions found; nothing to regenerate')
    sessions, counters = [], {'qs': 0, 'ans': 0, 'dec': 0, 'apr': 0, 'rsk': 0}
    for qs_id, v in sorted(rec.sessions.items()):
        if not (v.evidence_status == 'confirmed' or v.effective_state == 'PENDING'):
            raise RegenerationError(
                f'{qs_id}: effective state {v.effective_state} has evidence_status '
                f'{v.evidence_status!r}; only confirmed evidence (or PENDING) is regenerated')
        e = {'question_session_id': qs_id, 'state': v.effective_state, 'generated_at': v.generated_at,
             'records': v.record_ids}
        if v.answered_at: e['answered_at'] = v.answered_at
        if v.session_label: e['session_label'] = v.session_label
        if v.answer_session_id: e['answer_session_id'] = v.answer_session_id
        sessions.append(e)
        counters['qs'] = max(counters['qs'], identity.parse_id(qs_id)[1])
        if v.answer_session_id: counters['ans'] = max(counters['ans'], identity.parse_id(v.answer_session_id)[1])
    for f in inventory(root):
        if f.kind == 'decision_record' and f.artifact_id:
            p, n = identity.parse_id(f.artifact_id)
            counters[RECORD_COUNTERS[p]] = max(counters[RECORD_COUNTERS[p]], n)
    latest_id = max(rec.sessions.items(), key=lambda kv: (kv[1].generated_at or '', kv[0]))[0]
    doc = {'sessions': sessions, 'counters': counters, 'latest': latest_id,
           'reconstructed': {'at': now, 'by': f'{run} (canonflow-human-decision-console)',
                             'source': 'artifacts+lifecycle+legacy-snapshots; state = evidence-derived effective state', 'preserved': True}}
    _, errors = profiles.validate_document(doc, 'decision-state')
    if errors:
        raise RegenerationError(f'regenerated index fails decision-state: {errors[:3]}')
    state_dir = paths.state_dir(root)
    paths.atomic_write_bytes(state_dir / paths.STATE_INDEX, (json.dumps(doc, ensure_ascii=False, indent=2) + '\n').encode())
    lv = rec.sessions[latest_id]
    latest = {'latest': latest_id, 'state': lv.effective_state, 'updated_at': now}
    paths.atomic_write_bytes(state_dir / paths.STATE_LATEST, (json.dumps(latest, ensure_ascii=False, indent=2) + '\n').encode())
    print(json.dumps({'sessions': [(s['question_session_id'], s['state']) for s in sessions], 'counters': counters, 'latest': latest}, ensure_ascii=False))
    for d in rec.diagnostics.values():
        print('DIAG', d.code, d.severity, d.scope)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='HDC-0006-regenerate-compat-views')
    parser.add_argument('--run', required=True, help='skill run id recorded in reconstructed.by (RUN-NNNN)')
    parser.add_argument('--project', default='.', help='project root (default: current directory)')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'RUN-\d{4}', args.run):
        print(f'error: --run must look like RUN-NNNN, got {args.run!r}', file=sys.stderr)
        return 2
    root = Path(args.project).expanduser().resolve()
    if not paths.state_dir(root).parent.is_dir():
        print(f'error: {root} has no .canonflow/ directory', file=sys.stderr)
        return 2
    try:
        regenerate(root, args.run)
    except Exception as exc:  # any failure: report it, never a partial success
        print(f'error: compatibility views not regenerated: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
