-- G-SEC/R1 exceptional one-off DBA repair of LEGACY platform audit rows that block anonymization (DEC-0027).
-- NEVER a normal migration: run only with explicit G-SEC/G-MIG owner authorization, maintenance window, a verified
-- restorable backup, writers stopped and the read-only preflight (scripts/plan-catalog-legacy-audit-preflight.sql,
-- same predicates). No automatic execution in scripts/migrate.ts.
--
-- Before 0034 the platform guard wrote `req.path` (e.g. /tenants/client_x/plan, any case, optional trailing slash)
-- into DENIED rows WITHOUT tenant_id. Anonymization cannot re-key those rows and its verification (assertNoTraces)
-- fails on the literal ID. This script rewrites ONLY `resource` of those rows to the route pattern the current code
-- writes (/api/platform/tenants/:id[/plan|/status|/data-classification|/support-access|/support-view]); every other
-- column is verified unchanged. It REFUSES, changing nothing, while platform_audit_event holds any other identifier
-- of a live tenant that anonymization could not remove (rows without tenant: any column; rows with tenant: actor_id
-- and result, which the 0027 guard keeps).
--
-- Optional, ONLY with an explicit owner decision: legacy failed platform logins stored the typed login in clear
-- (`login:<text>`, possibly a business e-mail). REDACT_LEGACY_LOGIN_ACTORS=1 rewrites those actor_id values to
-- `login:legacy-redacted` (the "actor" of an unauthenticated attempt is only a claimed login).
--
-- Usage (table owner; every refusal exits non-zero without changes; ON_ERROR_STOP is imposed here):
--   psql "$DATABASE_URL" -X -v APPLY=1 -v TARGET_DB=<database name> -v EXPECTED_ROWS=<N from preflight> \
--        [-v REDACT_LEGACY_LOGIN_ACTORS=1 -v EXPECTED_LOGIN_ROWS=<M from preflight>] \
--        -f scripts/plan-catalog-legacy-audit-repair.sql
\set ON_ERROR_STOP on

\if :{?APPLY}
\else
  \set APPLY ''
\endif
\if :{?EXPECTED_ROWS}
\else
  \set EXPECTED_ROWS ''
\endif
\if :{?TARGET_DB}
\else
  \set TARGET_DB ''
\endif
\if :{?REDACT_LEGACY_LOGIN_ACTORS}
\else
  \set REDACT_LEGACY_LOGIN_ACTORS '0'
\endif
\if :{?EXPECTED_LOGIN_ROWS}
\else
  \set EXPECTED_LOGIN_ROWS ''
\endif
-- Validated by the server, not by psql's lenient booleans: exact values only.
SELECT :'APPLY' = '1' AS repair_apply_ok,
       :'EXPECTED_ROWS' ~ '^[0-9]{1,12}$' AS repair_expected_ok,
       :'TARGET_DB' = current_database() AS repair_target_ok,
       :'REDACT_LEGACY_LOGIN_ACTORS' IN ('0', '1')
         AND (:'REDACT_LEGACY_LOGIN_ACTORS' = '0' OR :'EXPECTED_LOGIN_ROWS' ~ '^[0-9]{1,12}$') AS repair_redact_ok \gset
\if :repair_apply_ok
\else
  \echo 'BLOCKED: require -v APPLY=1 (exactly 1) and explicit G-SEC/G-MIG owner authorization. Nothing changed.'
  SELECT 1/0 AS required_approval_missing;
\endif
\if :repair_expected_ok
\else
  \echo 'BLOCKED: require -v EXPECTED_ROWS=<integer reported by the read-only preflight>. Nothing changed.'
  SELECT 1/0 AS required_expected_rows_missing;
\endif
\if :repair_target_ok
\else
  \echo 'BLOCKED: -v TARGET_DB must name the database this session is connected to. Nothing changed.'
  SELECT 1/0 AS target_database_mismatch;
\endif
\if :repair_redact_ok
\else
  \echo 'BLOCKED: REDACT_LEGACY_LOGIN_ACTORS must be 0 or 1, and 1 requires -v EXPECTED_LOGIN_ROWS=<integer>. Nothing changed.'
  SELECT 1/0 AS redact_parameters_invalid;
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '15min';
-- Same key as scripts/migrate.ts and the rollback scripts: never concurrent with a migration.
SELECT pg_advisory_xact_lock(hashtext('mainspot_migrations')) \gset repair_lock_
-- ACCESS EXCLUSIVE (stronger than the SHARE ROW EXCLUSIVE that DISABLE TRIGGER takes): no other session reads or
-- writes the table while its immutability trigger is disabled, and the candidate counts cannot change.
LOCK TABLE platform_audit_event IN ACCESS EXCLUSIVE MODE;
SELECT set_config('repair.expected', :'EXPECTED_ROWS', true) AS a,
       set_config('repair.redact', :'REDACT_LEGACY_LOGIN_ACTORS', true) AS b,
       set_config('repair.expected_login', :'EXPECTED_LOGIN_ROWS', true) AS c \gset repair_cfg_

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'platform_audit_event'::regclass AND t.tgname = 'trg_platform_audit_immutable'
                    AND t.tgenabled = 'O' AND p.proname = 'platform_audit_guard') THEN
    RAISE EXCEPTION 'repair: trg_platform_audit_immutable is missing, disabled or not bound to platform_audit_guard() (0027)';
  END IF;
END $pre$;

-- Strong identifiers of every live tenant, as RetentionService.identifiers() collects them (trimmed, >= 4 chars),
-- with the identifier boundary assertNoTraces() applies.
CREATE TEMP TABLE repair_pattern ON COMMIT DROP AS
SELECT DISTINCT '(^|[^A-Za-z0-9_-])' || regexp_replace(x.v, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '([^A-Za-z0-9_-]|$)' AS re
  FROM (
    SELECT btrim(c.client_id) AS v FROM client c WHERE c.status <> 'anonymized'
    UNION ALL SELECT btrim(c.contact_email) FROM client c WHERE c.status <> 'anonymized'
    UNION ALL SELECT btrim(u.user_id) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
    UNION ALL SELECT btrim(u.login) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
    UNION ALL SELECT btrim(w.slug) FROM client_website w JOIN client c ON c.client_id = w.tenant_id AND c.status <> 'anonymized'
    UNION ALL SELECT btrim(d.subdomain) FROM client_domain d JOIN client c ON c.client_id = d.tenant_id AND c.status <> 'anonymized'
  ) x
 WHERE x.v IS NOT NULL AND length(x.v) >= 4;

CREATE TEMP TABLE repair_candidate ON COMMIT DROP AS
SELECT event_id,
       '/api/platform/tenants/:id' || COALESCE(lower(substring(resource FROM
         '(?i)^(?:/api/platform)?/tenants/[^/]+(/(?:plan|status|data-classification|support-access|support-view))?/?$')), '') AS canonical,
       md5(row(event_id, at, actor_id, actor_roles, action, tenant_id, decision, result, reason, request_id)::text) AS kept_digest
  FROM platform_audit_event
 WHERE tenant_id IS NULL AND decision = 'deny'
   AND resource ~* '^(/api/platform)?/tenants/[^/]+(/(plan|status|data-classification|support-access|support-view))?/?$'
   AND resource !~* '^(/api/platform)?/tenants/:id(/|$)';

CREATE TEMP TABLE repair_login ON COMMIT DROP AS
SELECT event_id,
       md5(row(event_id, at, actor_roles, action, resource, tenant_id, decision, result, reason, request_id)::text) AS kept_digest
  FROM platform_audit_event
 WHERE current_setting('repair.redact') = '1'
   AND action = 'platform.login' AND decision = 'deny'
   AND actor_id LIKE 'login:%' AND actor_id !~ '^login:([0-9a-f]{64}|unknown|legacy-redacted)$';

DO $count$
DECLARE
  found BIGINT;
  found_login BIGINT;
BEGIN
  SELECT count(*) INTO found FROM repair_candidate;
  SELECT count(*) INTO found_login FROM repair_login;
  IF found = 0 AND found_login = 0 THEN
    RAISE EXCEPTION 'repair: nothing to repair (0 candidates); nothing changed';
  END IF;
  IF found <> current_setting('repair.expected')::bigint THEN
    RAISE EXCEPTION 'repair: candidate count changed; found %, expected %. Re-run the preflight', found, current_setting('repair.expected');
  END IF;
  IF current_setting('repair.redact') = '1' AND found_login <> current_setting('repair.expected_login')::bigint THEN
    RAISE EXCEPTION 'repair: legacy login count changed; found %, expected %', found_login, current_setting('repair.expected_login');
  END IF;
END $count$;

-- Out of contract: anything that would still make assertNoTraces() fail and that this script does not rewrite.
DO $block$
DECLARE
  r RECORD;
  total BIGINT := 0;
BEGIN
  FOR r IN
    SELECT CASE WHEN c.client_id IS NULL THEN 'unbound.' ELSE 'bound.' END || v.col AS kind, count(DISTINCT e.event_id) AS n
      FROM platform_audit_event e
      LEFT JOIN client c ON c.client_id = e.tenant_id
      CROSS JOIN LATERAL (VALUES
        ('actor_id', CASE WHEN e.event_id IN (SELECT event_id FROM repair_login) THEN NULL ELSE e.actor_id END),
        ('result', e.result),
        ('resource', CASE WHEN c.client_id IS NULL AND e.event_id NOT IN (SELECT event_id FROM repair_candidate) THEN e.resource END),
        ('reason', CASE WHEN c.client_id IS NULL THEN e.reason END),
        ('request_id', CASE WHEN c.client_id IS NULL THEN e.request_id END),
        ('tenant_id', CASE WHEN c.client_id IS NULL THEN e.tenant_id END)) AS v(col, val)
     WHERE v.val IS NOT NULL
       AND (v.val ~ ANY (ARRAY(SELECT re FROM repair_pattern))
            OR (c.client_id IS NULL AND v.val ~ 'client_[A-Za-z0-9_-]+'))
     GROUP BY 1 ORDER BY 1
  LOOP
    RAISE WARNING 'repair: % row(s) with tenant identifiers in %', r.n, r.kind;
    total := total + r.n;
  END LOOP;
  IF total > 0 THEN
    RAISE EXCEPTION 'repair blocked: % row(s) outside this contract need manual review and an owner decision; nothing changed', total;
  END IF;
END $block$;

ALTER TABLE platform_audit_event DISABLE TRIGGER trg_platform_audit_immutable;
UPDATE platform_audit_event e SET resource = c.canonical FROM repair_candidate c WHERE e.event_id = c.event_id;
UPDATE platform_audit_event e SET actor_id = 'login:legacy-redacted' FROM repair_login l WHERE e.event_id = l.event_id;
ALTER TABLE platform_audit_event ENABLE TRIGGER trg_platform_audit_immutable;

DO $post$
DECLARE
  bad BIGINT;
BEGIN
  SELECT count(*) INTO bad
    FROM repair_candidate c LEFT JOIN platform_audit_event e USING (event_id)
   WHERE e.event_id IS NULL OR e.resource IS DISTINCT FROM c.canonical
      OR e.resource !~ '^/api/platform/tenants/:id(/(plan|status|data-classification|support-access|support-view))?$'
      OR md5(row(e.event_id, e.at, e.actor_id, e.actor_roles, e.action, e.tenant_id, e.decision, e.result, e.reason, e.request_id)::text) <> c.kept_digest;
  IF bad > 0 THEN
    RAISE EXCEPTION 'repair postcondition failed: % candidate row(s) not rewritten or changed outside resource', bad;
  END IF;
  SELECT count(*) INTO bad
    FROM repair_login l LEFT JOIN platform_audit_event e USING (event_id)
   WHERE e.event_id IS NULL OR e.actor_id <> 'login:legacy-redacted'
      OR md5(row(e.event_id, e.at, e.actor_roles, e.action, e.resource, e.tenant_id, e.decision, e.result, e.reason, e.request_id)::text) <> l.kept_digest;
  IF bad > 0 THEN
    RAISE EXCEPTION 'repair postcondition failed: % login row(s) changed outside actor_id', bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'platform_audit_event'::regclass AND t.tgname = 'trg_platform_audit_immutable'
                    AND t.tgenabled = 'O' AND p.proname = 'platform_audit_guard') THEN
    RAISE EXCEPTION 'repair postcondition failed: immutability trigger is not enabled again';
  END IF;
  -- Functional proof: the guard rejects an UPDATE again.
  BEGIN
    UPDATE platform_audit_event SET resource = resource
     WHERE event_id = (SELECT min(event_id) FROM (SELECT event_id FROM repair_candidate UNION ALL SELECT event_id FROM repair_login) ids);
    RAISE EXCEPTION 'repair postcondition failed: platform_audit_event accepted an UPDATE after the repair' USING ERRCODE = 'P0001';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM platform_audit_event e LEFT JOIN client c ON c.client_id = e.tenant_id
     CROSS JOIN LATERAL (VALUES (e.actor_id), (e.resource), (e.result), (e.reason), (e.request_id), (e.tenant_id)) AS v(val)
     WHERE c.client_id IS NULL AND v.val IS NOT NULL
       AND (v.val ~ ANY (ARRAY(SELECT re FROM repair_pattern)) OR v.val ~ 'client_[A-Za-z0-9_-]+')) THEN
    RAISE EXCEPTION 'repair postcondition failed: tenant identifiers remain in rows without tenant';
  END IF;
END $post$;

-- Append-only evidence of the exceptional sanitization: counts only, no identifiers or event IDs.
INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason, request_id)
SELECT 'pae_' || gen_random_uuid()::text, 'system:authorized-legacy-audit-repair', ARRAY[]::text[],
       'platform.audit.legacy_deny_sanitized', 'platform_audit_event', NULL, 'allow',
       'rows:' || (SELECT count(*) FROM repair_candidate) || ' login_actors:' || (SELECT count(*) FROM repair_login), NULL, NULL;
COMMIT;
\echo 'OK: legacy denials rewritten to route patterns, other columns verified, trigger enabled, evidence row written.'
