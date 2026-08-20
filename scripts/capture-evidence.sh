#!/usr/bin/env bash
# ============================================================
# Capture reproducible INC-001 evidence (AC-009).
# Usage: bash scripts/capture-evidence.sh   (or: npm run evidence)
# Requires: node >=24, npm, docker + docker compose (for postgres).
# Writes real outputs under evidence/.
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
EVIDENCE="${EVIDENCE_DIR:-evidence}"
mkdir -p "$EVIDENCE"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

note() { printf '\n==== %s ====\n' "$1"; }

tee_file() { tee "$1"; }   # print to stdout AND save

printf '# RUN %s\n' "$STAMP" > "$EVIDENCE/00-run-meta.txt"

note "environment"
{
  echo "run: $STAMP"
  echo "node: $(node -v)"
  echo "npm:  $(npm -v)"
  echo "docker: $(docker --version)"
  echo "docker compose: $(docker compose version)"
  echo "git: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 'no-commit-yet')"
  git -C "$ROOT" status --short
} | tee_file "$EVIDENCE/00-environment.txt"

note "typecheck (tsc --noEmit)"
npm run typecheck 2>&1 | tee_file "$EVIDENCE/01-typecheck.txt"
TYPECHECK_OK=$?

note "permission matrix (AC-001 evidence)"
npm run matrix 2>&1 | tee_file "$EVIDENCE/02-permission-matrix.txt"

note "unit tests (no DB)"
npm run test:unit 2>&1 | tee_file "$EVIDENCE/03-unit-tests.txt"
UNIT_OK=$?

note "db up (docker compose postgres)"
if docker compose up -d postgres >> "$EVIDENCE/04-db-up.txt" 2>&1; then
  echo "postgres up" >> "$EVIDENCE/04-db-up.txt"
  # wait until healthy (max ~45s)
  for i in $(seq 1 45); do
    if docker compose exec -T postgres pg_isready -U mainspot -d mainspot >/dev/null 2>&1; then
      echo "postgres ready after ${i}s" >> "$EVIDENCE/04-db-up.txt"
      break
    fi
    sleep 1
  done
  DB_UP_OK=0
else
  DB_UP_OK=1
fi

note "migrate + seed (dev db)"
npm run db:setup 2>&1 | tee_file "$EVIDENCE/05-db-setup.txt"
DB_SETUP_OK=$?

note "integration tests (2 tenants, DB)"
npm run test:integration 2>&1 | tee_file "$EVIDENCE/06-integration-tests.txt"
INTEGRATION_OK=$?

note "denied cross-tenant evidence (AC-002 — right after integration)"
{
  echo "# Denied cross-client attempts (evidence AC-002) — run $STAMP"
  echo "# Source: audit_event rows with decision=deny in the TEST database."
  psql_available=0
  # Prefer docker compose exec; fall back to psql if present locally.
  if docker compose exec -T postgres psql -U mainspot -d mainspot_test -c "
    SELECT event_id, ts, tenant_id, actor_id, action, resource, request_id, decision, result
    FROM audit_event WHERE decision='deny'
    ORDER BY ts DESC LIMIT 30;" > "$EVIDENCE/08-denied-cross-tenant.txt" 2>/dev/null; then
    cat "$EVIDENCE/08-denied-cross-tenant.txt"
    psql_available=1
  elif command -v psql >/dev/null 2>&1; then
    psql "${DATABASE_URL:-postgres://mainspot:mainspot_dev_password@localhost:5432/mainspot}" -c "
      SELECT event_id, tenant_id, actor_id, action, resource, request_id, decision, result
      FROM audit_event WHERE decision='deny' ORDER BY ts DESC LIMIT 30;" | tee_file "$EVIDENCE/08-denied-cross-tenant.txt"
    psql_available=1
  fi
  if [ "$psql_available" = "0" ]; then
    echo "(no psql available; denied events are captured in 06-integration-tests.txt and audit export)" >> "$EVIDENCE/08-denied-cross-tenant.txt"
  fi
}

note "audit export (AC-003 evidence — from the deterministic test DB)"
TESTURL="${TEST_DATABASE_URL:-postgres://mainspot:mainspot_dev_password@localhost:5432/mainspot_test}"
npm run export:audit -- --tenant client_a --url "$TESTURL" --out "$EVIDENCE/audit-export-client-a.json" 2>&1 | tee_file "$EVIDENCE/09-audit-export.txt"
npm run export:audit -- --tenant client_b --url "$TESTURL" --out "$EVIDENCE/audit-export-client-b.json" 2>&1 | tee_file "$EVIDENCE/10-audit-export-b.txt"

note "smoke tests (AC-009 + UX signs)"
npm run test:smoke 2>&1 | tee_file "$EVIDENCE/07-smoke.txt"
SMOKE_OK=$?

note "e2e INC-002 + INC-003 (canal simulado, DEC-026) — transcript + evidence file"
npm run test:e2e 2>&1 | tee_file "$EVIDENCE/13-e2e-inc002-inc003.txt"
E2E_OK=$?

note "rollback simulation (AC-009 — from the deterministic test DB)"
npm run rollback:simulate -- --url "$TESTURL" 2>&1 | tee_file "$EVIDENCE/11-rollback-simulate.txt"

note "summary"
cat <<EOF | tee_file "$EVIDENCE/12-summary.txt"
run: $STAMP
typecheck:   $([ "$TYPECHECK_OK" = "0" ] && echo PASS || echo FAIL)
unit:        $([ "$UNIT_OK" = "0" ] && echo PASS || echo FAIL)
db up:       $([ "${DB_UP_OK:-1}" = "0" ] && echo PASS || echo FAIL-or-skipped)
db setup:    $([ "$DB_SETUP_OK" = "0" ] && echo PASS || echo FAIL)
integration: $([ "$INTEGRATION_OK" = "0" ] && echo PASS || echo FAIL)
smoke:       $([ "$SMOKE_OK" = "0" ] && echo PASS || echo FAIL)
e2e:         $([ "${E2E_OK:-1}" = "0" ] && echo PASS || echo FAIL)
EOF

echo
echo "Evidence saved under $EVIDENCE/ (run $STAMP)"
