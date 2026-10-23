#!/usr/bin/env python3
"""MainSpot's explicit, one-shot Cognitive Jev connection; no product operations.

OFF by default. Live review requires an ingested, byte-bound HDC approval of the
synthetic-only activation proposal. This launcher reuses CanonFlow unchanged.
"""
import argparse
from datetime import datetime, timezone
import getpass
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
PROJECT = Path(__file__).absolute().parents[1]
FRAMEWORK = PROJECT.parent.parent / 'canonflow-keystone'
PIN = '5e3dc307a4089f462b9742b76fd002cf910102fa'
CREDENTIAL = Path.home() / '.config/mainspot/cognitive-jev/typesafe-api-key'
RUNTIME = Path.home() / '.local/share/mainspot/cognitive-jev/venv'
INPUT = '.canonflow/cognitive/synthetic-p0/input.json'
CONFIG = '.canonflow/cognitive/config.yaml'
CANDIDATE = '.canonflow/cognitive/live-candidate.yaml'
PROPOSAL = '.canonflow/state/cognitive-jev-activation-proposal.json'
ARTIFACT = 'MSP-COGNITIVE-JEV-ACTIVATION v1'
ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
MODEL = 'jev-1.13.0'
# Imported framework implementation and schemas, not unrelated owner-lab profiles.
FRAMEWORK_PATHS = (
    'scripts/cognitive_jev.py', 'scripts/cognitive_slice.py',
    'scripts/cognitive_loops.py', 'scripts/cognitive_governance.py',
    'scripts/check_gates.py', 'scripts/validate_schemas_v2.py',
    'scripts/validate_traceability.py', 'decision-console/app/canonflow_hdc',
    'schemas/cognitive-input.schema.yaml', 'schemas/cognitive-evaluation.schema.yaml',
    'schemas/route-authorization.schema.yaml', 'schemas/skill-selection-report.schema.yaml',
    'schemas/increment-contract.schema.yaml', 'schemas/skill-registry.schema.yaml',
    'schemas/runtime-manifest.schema.yaml', 'schemas/drift-audit.schema.yaml',
    'schemas/standing-policy.schema.yaml',
)


class ConnectionError(Exception):
    """Fixed local error codes; never include credential or provider exception text."""


def _bytes(relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ConnectionError('UNSAFE_PROJECT_PATH')
    target = PROJECT / path
    if any(p.is_symlink() for p in (target, *target.parents)):
        raise ConnectionError('SYMLINK_REFUSED')
    if not target.is_file() or target.stat().st_size > 262144:
        raise ConnectionError('PROJECT_INPUT_UNAVAILABLE')
    return target.read_bytes()


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _private_parent():
    parent = CREDENTIAL.parent
    if any(p.is_symlink() for p in (parent, *parent.parents)):
        raise ConnectionError('UNSAFE_CREDENTIAL_DIRECTORY')
    info = parent.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ConnectionError('UNSAFE_CREDENTIAL_DIRECTORY')


def _credential_fd():
    _private_parent()
    fd = os.open(CREDENTIAL, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or not 0 < info.st_size <= 4096):
        os.close(fd)
        raise ConnectionError('UNSAFE_CREDENTIAL_FILE')
    return fd


def credential_presence():
    try:
        fd = _credential_fd()
    except FileNotFoundError:
        return 'ABSENT'
    else:
        os.close(fd)
        return 'PRESENT_PERMISSIONS_VERIFIED'


def set_key():
    if not sys.stdin.isatty():
        raise ConnectionError('INTERACTIVE_TERMINAL_REQUIRED')
    _private_parent()
    if CREDENTIAL.exists() or CREDENTIAL.is_symlink():
        raise ConnectionError('CREDENTIAL_ALREADY_EXISTS')
    key = getpass.getpass('TypeSafe API key (hidden, stored locally only): ')
    if not key or len(key) > 4095 or any(ord(c) <= 32 or ord(c) > 126 for c in key):
        raise ConnectionError('CREDENTIAL_INVALID')
    fd = os.open(CREDENTIAL, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(key.encode('ascii') + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'credential': credential_presence(), 'path': str(CREDENTIAL),
                      'network_requests': 0}))


def _framework():
    if any(p.is_symlink() for p in (FRAMEWORK, *FRAMEWORK.parents)):
        raise ConnectionError('UNTRUSTED_FRAMEWORK_PATH')
    result = subprocess.run(
        ['git', '--no-optional-locks', '-C', str(FRAMEWORK), 'diff', '--quiet', PIN,
         '--', *FRAMEWORK_PATHS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode != 0:
        raise ConnectionError('FRAMEWORK_PIN_MISMATCH')
    sys.path.insert(0, str(FRAMEWORK / 'scripts'))
    import cognitive_governance
    import cognitive_loops
    import validate_schemas_v2
    return cognitive_governance, cognitive_loops, validate_schemas_v2


def _authorize(governance, record_ref):
    assessment = governance.assess_human_source(PROJECT, record_ref)
    binding = (assessment.get('record') or {}).get('artifact_binding')
    expected = {'artifact_ref': ARTIFACT, 'path': PROPOSAL,
                'sha256': _hash(_bytes(PROPOSAL))}
    if not assessment['valid'] or binding != expected:
        raise ConnectionError('HDC_AUTHORIZATION_REQUIRED')
    proposal = json.loads(_bytes(PROPOSAL))
    if (proposal.get('framework_sha') != PIN or proposal.get('endpoint') != ENDPOINT
            or proposal.get('model') != MODEL or proposal.get('data_scope') != 'SYNTHETIC_ONLY'
            or proposal.get('input') != INPUT):
        raise ConnectionError('ACTIVATION_SCOPE_REFUSED')
    expiry = datetime.fromisoformat(proposal['valid_until'].replace('Z', '+00:00'))
    if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
        raise ConnectionError('ACTIVATION_EXPIRED')
    files = proposal.get('files')
    document = json.loads(_bytes(INPUT))
    verification = document['verification']
    required = {INPUT, CANDIDATE, 'scripts/canonflow-jev.py',
                'scripts/canonflow-jev-requirements.lock', *document['scope']['paths'],
                *(item['path'] for item in document['evidence']),
                verification['canon_index'], verification['links'],
                verification['evidence_package'], *verification['id_sources'],
                *(item['path'] for item in document['transition']['bindings'].values())}
    if not isinstance(files, dict) or set(files) != required:
        raise ConnectionError('DATA_MANIFEST_INCOMPLETE')
    if any(_hash(_bytes(path)) != digest for path, digest in files.items()):
        raise ConnectionError('APPROVED_INPUT_CHANGED')
    return proposal


def review(*, live=False, approval=None):
    governance, loops, schemas = _framework()
    config = schemas.load(PROJECT / CONFIG)
    if live:
        proposal = _authorize(governance, approval)
        config = schemas.load(PROJECT / CANDIDATE)
        if (config.get('enabled') is not True or config.get('data_policy_approved') is not True
                or config.get('model') != MODEL or config.get('max_calls') != 1
                or config.get('max_cost_usd') != proposal['local_admission_budget_usd']
                or not 0 < config['max_cost_usd'] <= 0.001
                or not 0 < config.get('timeout_seconds', 0) <= 10):
            raise ConnectionError('APPROVED_CONFIG_REFUSED')
        fd = _credential_fd()
        with os.fdopen(fd, 'rb') as stream:
            key = stream.read(4097).decode('ascii').strip()
        if not key or any(ord(c) <= 32 or ord(c) > 126 for c in key):
            raise ConnectionError('CREDENTIAL_INVALID')
        os.environ['TYPESAFE_API_KEY'] = key
    else:
        # Offline never reads the key or accepts an enabled configuration.
        config = {**config, 'enabled': False, 'data_policy_approved': False, 'max_cost_usd': 0}
    old_umask = os.umask(0o077)
    try:
        handoff = loops.review(PROJECT, INPUT, PROJECT / 'out/cognitive/mainspot-p0', config=config)
    finally:
        os.umask(old_umask)
        os.environ.pop('TYPESAFE_API_KEY', None)
    trace = json.loads(Path(handoff['trace_path']).read_bytes())
    if trace.get('advisory_only') is not True or trace.get('authorization') is not None or trace.get('execution') != 'NONE':
        raise ConnectionError('ADVISORY_INVARIANT_VIOLATED')
    meta = (trace.get('cognitive') or {}).get('meta') or {}
    live_verified = (live and trace.get('cognitive_status') == 'EVALUATED'
                     and meta.get('provider') == 'typesafe' and meta.get('http_status') == 200
                     and meta.get('resolved_model') == MODEL and trace.get('replay') is False)
    summary = {**handoff, 'advisory_only': True, 'synthetic_only': True,
               'live_advisory_verified': live_verified,
               'provider_http_status': meta.get('http_status'), 'provider_model': meta.get('resolved_model')}
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if not live or live_verified else 2


def main(argv=None):
    # Do not inherit CJL/other provider credentials, even if a shell exported them.
    for name in ('TYPESAFE_API_KEY', 'JEV_API_KEY', 'OPENROUTER_API_KEY'):
        os.environ.pop(name, None)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('status')
    commands.add_parser('set-key')
    commands.add_parser('review-offline')
    live = commands.add_parser('review-live')
    live.add_argument('--approval', required=True, help='ingested APR/DEC approving the exact activation proposal')
    args = parser.parse_args(argv)
    try:
        if args.command.startswith('review-') and Path(sys.prefix) != RUNTIME:
            interpreter = RUNTIME / 'bin/python'
            if not interpreter.is_file() or any(p.is_symlink() for p in (RUNTIME, *RUNTIME.parents)):
                raise ConnectionError('COGNITIVE_RUNTIME_UNAVAILABLE')
            os.execv(str(interpreter), [str(interpreter), '-I', '-B', str(Path(__file__).absolute()),
                                      *(sys.argv[1:] if argv is None else argv)])
        if args.command == 'status':
            print(json.dumps({'state': 'OFF', 'credential': credential_presence(),
                              'credential_path': str(CREDENTIAL), 'framework_sha': PIN,
                              'runtime_python': str(RUNTIME / 'bin/python'),
                              'live_requires': 'INGESTED_HDC_APPROVAL_AND_CREDENTIAL',
                              'network_requests': 0}))
            return 0
        if args.command == 'set-key':
            set_key()
            return 0
        return review(live=args.command == 'review-live', approval=getattr(args, 'approval', None))
    except ConnectionError as error:
        print(json.dumps({'error': str(error), 'execution': 'NONE'}), file=sys.stderr)
        return 2
    except Exception:
        print(json.dumps({'error': 'COGNITIVE_CONNECTION_FAILED_CLOSED', 'execution': 'NONE'}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
