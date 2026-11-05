-- G-SEC hardening rollback for migration 0035 ONLY. Not a rollback of migration 0034.
-- Stop application/worker processes and deploy the previous code (PR #13) together with this schema change.
-- This erases rolling rate-limit counters and must be authorized in the maintenance window.
--   psql "$DATABASE_URL" -X -f scripts/plan-catalog-hardening-rollback.sql
-- Single transaction; any refusal exits non-zero and changes nothing (the script imposes ON_ERROR_STOP).
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('mainspot_migrations'));
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file='0035_platform_auth_shared_attempts.sql') THEN
   RAISE EXCEPTION 'Migration 0035 not registered: abort';
 END IF;
 IF EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0035_platform_auth_shared_attempts.sql') THEN
   RAISE EXCEPTION 'Newer migrations detected: abort';
 END IF;
END $$;
DROP TABLE platform_auth_attempt_gate;
DELETE FROM schema_migrations WHERE file='0035_platform_auth_shared_attempts.sql';
COMMIT;
