#!/usr/bin/env python3
"""Offline consumer security boundaries. Never loads a real credential or uses HTTP."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

_spec = importlib.util.spec_from_file_location('mainspot_cognitive_jev', Path(__file__).with_name('canonflow-jev.py'))
connection = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(connection)


class CredentialBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.private = self.root / 'private'
        self.private.mkdir(mode=0o700)
        self.key = self.private / 'typesafe-api-key'
        self.key.write_text('offline-fixture-only\n')
        self.key.chmod(0o600)
        self.override = patch.object(connection, 'CREDENTIAL', self.key)
        self.override.start()
        self.addCleanup(self.override.stop)

    def test_absent_key_is_reported_without_reading_a_value(self):
        self.key.unlink()
        self.assertEqual('ABSENT', connection.credential_presence())

    def test_group_readable_file_and_directory_are_refused(self):
        self.key.chmod(0o640)
        with self.assertRaisesRegex(connection.ConnectionError, 'UNSAFE_CREDENTIAL_FILE'):
            connection.credential_presence()
        self.key.chmod(0o600)
        self.private.chmod(0o750)
        with self.assertRaisesRegex(connection.ConnectionError, 'UNSAFE_CREDENTIAL_DIRECTORY'):
            connection.credential_presence()

    def test_symlink_and_nonregular_credential_are_refused(self):
        target = self.root / 'foreign-key'
        self.key.rename(target)
        self.key.symlink_to(target)
        with self.assertRaises(OSError):
            connection.credential_presence()
        self.key.unlink()
        self.key.mkdir(mode=0o600)
        with self.assertRaisesRegex(connection.ConnectionError, 'UNSAFE_CREDENTIAL_FILE'):
            connection.credential_presence()

    def test_noninteractive_key_entry_fails_before_prompt_or_write(self):
        self.key.unlink()
        with patch.object(connection.sys.stdin, 'isatty', return_value=False), patch.object(connection.getpass, 'getpass') as prompt:
            with self.assertRaisesRegex(connection.ConnectionError, 'INTERACTIVE_TERMINAL_REQUIRED'):
                connection.set_key()
        prompt.assert_not_called()
        self.assertFalse(self.key.exists())


class ActivationBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.override = patch.object(connection, 'PROJECT', self.root)
        self.override.start()
        self.addCleanup(self.override.stop)
        self.input = {'scope': {'paths': ['facts.txt']},
                      'evidence': [{'path': 'facts.txt'}],
                      'verification': {'canon_index': 'canon.yaml', 'links': 'links.yaml',
                                       'evidence_package': 'evidence.yaml', 'id_sources': ['ids.yaml']},
                      'transition': {'bindings': {}}}
        paths = {connection.INPUT: json.dumps(self.input), connection.CANDIDATE: 'enabled: true\n',
                 'scripts/canonflow-jev.py': 'synthetic-consumer-identity', 'facts.txt': 'synthetic evidence',
                 'scripts/canonflow-jev-requirements.lock': 'synthetic-dependency-lock',
                 'canon.yaml': '{}', 'links.yaml': '{}', 'evidence.yaml': '{}', 'ids.yaml': '{}'}
        for relative, content in paths.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.proposal = {'framework_sha': connection.PIN, 'endpoint': connection.ENDPOINT,
                         'model': connection.MODEL, 'data_scope': 'SYNTHETIC_ONLY', 'input': connection.INPUT,
                         'valid_until': '2099-01-01T00:00:00+00:00',
                         'files': {path: hashlib.sha256(content.encode()).hexdigest() for path, content in paths.items()}}
        self.path = self.root / connection.PROPOSAL
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.proposal))
        self.governance = Mock()
        self.refresh_approval()

    def refresh_approval(self, valid=True):
        self.governance.assess_human_source.return_value = {
            'valid': valid, 'record': {'artifact_binding': {'artifact_ref': connection.ARTIFACT,
            'path': connection.PROPOSAL, 'sha256': hashlib.sha256(self.path.read_bytes()).hexdigest()}}}

    def test_uningested_or_invalid_hdc_record_cannot_enable_provider(self):
        self.refresh_approval(valid=False)
        with self.assertRaisesRegex(connection.ConnectionError, 'HDC_AUTHORIZATION_REQUIRED'):
            connection._authorize(self.governance, 'APR-0001')

    def test_changed_payload_after_human_approval_is_refused(self):
        (self.root / 'facts.txt').write_text('private unauthorized replacement')
        with self.assertRaisesRegex(connection.ConnectionError, 'APPROVED_INPUT_CHANGED'):
            connection._authorize(self.governance, 'APR-0001')

    def test_incomplete_data_manifest_is_refused_even_with_bound_approval(self):
        del self.proposal['files']['facts.txt']
        self.path.write_text(json.dumps(self.proposal))
        self.refresh_approval()
        with self.assertRaisesRegex(connection.ConnectionError, 'DATA_MANIFEST_INCOMPLETE'):
            connection._authorize(self.governance, 'APR-0001')

    def test_missing_hdc_authority_never_reads_key_or_calls_loop(self):
        self.refresh_approval(valid=False)
        loops = Mock()
        schemas = Mock()
        with patch.object(connection, '_framework', return_value=(self.governance, loops, schemas)), patch.object(connection, '_credential_fd') as credential:
            with self.assertRaisesRegex(connection.ConnectionError, 'HDC_AUTHORIZATION_REQUIRED'):
                connection.review(live=True, approval='APR-0001')
        credential.assert_not_called()
        loops.review.assert_not_called()

    def test_expired_activation_cannot_be_reused(self):
        self.proposal['valid_until'] = '2000-01-01T00:00:00+00:00'
        self.path.write_text(json.dumps(self.proposal))
        self.refresh_approval()
        with self.assertRaisesRegex(connection.ConnectionError, 'ACTIVATION_EXPIRED'):
            connection._authorize(self.governance, 'APR-0001')


if __name__ == '__main__':
    unittest.main(verbosity=2)
