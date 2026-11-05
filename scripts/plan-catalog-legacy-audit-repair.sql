-- G-SEC/R1 exceptional one-off repair for legacy *denied* platform routes containing a literal tenant ID.
-- This is NEVER a normal migration: run only with explicit G-SEC/G-MIG authorization, maintenance window,
-- a verified backup, and the read-only preflight. No automatic execution in scripts/migrate.ts.
--
-- ONLY whitelisted routes are repaired; all other cases are intentionally left for manual analysis.
-- Changes *resource only*, preserving event_id, actor, timestamp, action, decision, result, reason, request_id.
-- The immutable-audit trigger is disabled only inside this transaction; any error rolls back its state.
--
-- Usage (after verifying preflight candidate count and DB snapshot):
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v APPLY=1 -v EXPECTED_ROWS=<count> \
--   -f scripts/plan-catalog-legacy-audit-repair.sql
-- Refuse to run from CI or an app/worker connection; requires DDL privilege of the table owner.
\if :{?APPLY}
\else
  \echo 'BLOCKED: require -v APPLY=1 and explicit G-SEC/G-MIG owner authorization.'
  \quit 3
\endif
\if :APPLY
\else
  \echo 'BLOCKED: APPLY must be 1.'
  \quit 3
\endif
\if :{?EXPECTED_ROWS}
\else
  \echo 'BLOCKED: require -v EXPECTED_ROWS=<count from read-only preflight>.'
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('mainspot_migrations'));
-- A 0034 deployment may coexist with this cleanup. Prevent concurrent inserts and guarantee count stability.
LOCK TABLE platform_audit_event IN SHARE ROW EXCLUSIVE MODE;
SELECT set_config('mainspot.audit_repair_expected', :'EXPECTED_ROWS', true);
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM platform_audit_event
   WHERE tenant_id IS NULL AND decision = 'deny'
     AND resource ~ '^(/api/platform)?/tenants/client_[A-Za-z0-9_-]+(/(plan|status|data-classification|support-access|support-view))?$';
  IF n <> current_setting('mainspot.audit_repair_expected')::bigint THEN
    RAISE EXCEPTION 'Legacy-audit repair: candidate count changed; found %, expected %', n, current_setting('mainspot.audit_repair_expected');
  END IF;
END $$;

CREATE TEMP TABLE legacy_audit_repair_ids ON COMMIT DROP AS
SELECT event_id
  FROM platform_audit_event
 WHERE tenant_id IS NULL AND decision = 'deny'
   AND resource ~ '^(/api/platform)?/tenants/client_[A-Za-z0-9_-]+(/(plan|status|data-classification|support-access|support-view))?$';
ALTER TABLE platform_audit_event DISABLE TRIGGER trg_platform_audit_immutable;
UPDATE platform_audit_event a
   SET resource = regexp_replace(a.resource, '^((/api/platform)?/tenants/)[^/?#]+', '\1:id')
 WHERE a.event_id IN (SELECT event_id FROM legacy_audit_repair_ids);
ALTER TABLE platform_audit_event ENABLE TRIGGER trg_platform_audit_immutable;

DO $$
DECLARE remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM platform_audit_event
   WHERE event_id IN (SELECT event_id FROM legacy_audit_repair_ids)
     AND resource !~ '^(/api/platform)?/tenants/:id(/(plan|status|data-classification|support-access|support-view))?$';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Legacy-audit repair postcondition failed: % unexpected resources', remaining;
  END IF;
END $$;

-- Append-only evidence of exceptional sanitization; no original PII or event IDs in the summary.
INSERT INTO platform_audit_event
  (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason)
SELECT 'pae_' || gen_random_uuid()::text,
       'system:authorized-legacy-audit-repair', ARRAY[]::text[],
       'platform.audit.legacy_deny_sanitized', 'audit/legacy-denials', NULL, 'allow',
       'rows:' || count(*)::text, NULL
FROM legacy_audit_repair_ids;
COMMIT;
