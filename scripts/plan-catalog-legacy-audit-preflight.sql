-- G-SEC/R1 read-only preflight, run BEFORE any legacy audit repair or migration outside development.
--   psql "$DATABASE_URL" -X -f scripts/plan-catalog-legacy-audit-preflight.sql
-- Only aggregate counts: no tenant identifier, login or event ID is emitted. Same predicates as
-- scripts/plan-catalog-legacy-audit-repair.sql. This does not authorize the repair.
\set ON_ERROR_STOP on
BEGIN READ ONLY;

-- 1. What the repair would rewrite: EXPECTED_ROWS and (only with an owner decision) EXPECTED_LOGIN_ROWS.
SELECT
  count(*) FILTER (
    WHERE tenant_id IS NULL AND decision = 'deny'
      AND resource ~* '^(/api/platform)?/tenants/[^/]+(/(plan|status|data-classification|support-access|support-view))?/?$'
      AND resource !~* '^(/api/platform)?/tenants/:id(/|$)'
  ) AS legacy_denials_eligible_for_targeted_repair,
  count(*) FILTER (
    WHERE action = 'platform.login' AND decision = 'deny'
      AND actor_id LIKE 'login:%' AND actor_id !~ '^login:([0-9a-f]{64}|unknown|legacy-redacted)$'
  ) AS legacy_failed_logins_with_clear_login
FROM platform_audit_event;

SELECT action, count(*) AS candidate_rows
  FROM platform_audit_event
 WHERE tenant_id IS NULL AND decision = 'deny'
   AND resource ~* '^(/api/platform)?/tenants/[^/]+(/(plan|status|data-classification|support-access|support-view))?/?$'
   AND resource !~* '^(/api/platform)?/tenants/:id(/|$)'
 GROUP BY action ORDER BY action;

-- 2. Strong identifiers of every live tenant (as RetentionService.identifiers(): trimmed, >= 4 chars) with the
-- identifier boundary of the anonymization verification (assertNoTraces). Shared by the queries below.
-- 2a. Rows of platform_audit_event outside the repair's contract (the repair refuses while any exists). Clear
-- legacy logins are listed apart: with REDACT_LEGACY_LOGIN_ACTORS=1 they are rewritten, without it they block
-- only when they name a tenant (kind legacy_clear_login).
WITH pat AS (
  SELECT DISTINCT x.tenant_id,
         '(^|[^A-Za-z0-9_-])' || regexp_replace(x.v, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '([^A-Za-z0-9_-]|$)' AS re
    FROM (
      SELECT c.client_id AS tenant_id, btrim(c.client_id) AS v FROM client c WHERE c.status <> 'anonymized'
      UNION ALL SELECT c.client_id, btrim(c.contact_email) FROM client c WHERE c.status <> 'anonymized'
      UNION ALL SELECT u.tenant_id, btrim(u.user_id) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT u.tenant_id, btrim(u.login) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT w.tenant_id, btrim(w.slug) FROM client_website w JOIN client c ON c.client_id = w.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT d.tenant_id, btrim(d.subdomain) FROM client_domain d JOIN client c ON c.client_id = d.tenant_id AND c.status <> 'anonymized'
    ) x
   WHERE x.v IS NOT NULL AND length(x.v) >= 4
), cells AS (
  SELECT e.event_id,
         CASE WHEN e.action = 'platform.login' AND e.decision = 'deny' AND e.actor_id LIKE 'login:%'
                   AND e.actor_id !~ '^login:([0-9a-f]{64}|unknown|legacy-redacted)$' AND v.col = 'actor_id'
              THEN 'legacy_clear_login'
              ELSE CASE WHEN c.client_id IS NULL THEN 'unbound.' ELSE 'bound.' END || v.col END AS kind,
         v.val
    FROM platform_audit_event e
    LEFT JOIN client c ON c.client_id = e.tenant_id
   CROSS JOIN LATERAL (VALUES
     ('actor_id', e.actor_id),
     ('result', e.result),
     ('resource', CASE WHEN c.client_id IS NULL AND NOT (e.tenant_id IS NULL AND e.decision = 'deny'
                   AND e.resource ~* '^(/api/platform)?/tenants/[^/]+(/(plan|status|data-classification|support-access|support-view))?/?$'
                   AND e.resource !~* '^(/api/platform)?/tenants/:id(/|$)') THEN e.resource END),
     ('reason', CASE WHEN c.client_id IS NULL THEN e.reason END),
     ('request_id', CASE WHEN c.client_id IS NULL THEN e.request_id END),
     ('tenant_id', CASE WHEN c.client_id IS NULL THEN e.tenant_id END)) AS v(col, val)
   WHERE v.val IS NOT NULL
)
SELECT kind AS out_of_contract_kind, count(DISTINCT event_id) AS rows_naming_a_tenant
  FROM cells
 WHERE val ~ ANY (ARRAY(SELECT re FROM pat))
    OR (kind LIKE 'unbound.%' AND val ~ 'client_[A-Za-z0-9_-]+')
 GROUP BY kind ORDER BY kind;

-- 2b. Anonymization blockers by store (DEC-0027): text that anonymization keeps and that names a live tenant.
-- The TOTAL row counts distinct tenants. The catalog stores exist only after 0034.
SELECT to_regclass('public.plan_catalog_event') IS NOT NULL AS preflight_has_plan_catalog \gset
\if :preflight_has_plan_catalog
WITH pat AS (
  SELECT DISTINCT x.tenant_id,
         '(^|[^A-Za-z0-9_-])' || regexp_replace(x.v, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '([^A-Za-z0-9_-]|$)' AS re
    FROM (
      SELECT c.client_id AS tenant_id, btrim(c.client_id) AS v FROM client c WHERE c.status <> 'anonymized'
      UNION ALL SELECT c.client_id, btrim(c.contact_email) FROM client c WHERE c.status <> 'anonymized'
      UNION ALL SELECT u.tenant_id, btrim(u.user_id) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT u.tenant_id, btrim(u.login) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT w.tenant_id, btrim(w.slug) FROM client_website w JOIN client c ON c.client_id = w.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT d.tenant_id, btrim(d.subdomain) FROM client_domain d JOIN client c ON c.client_id = d.tenant_id AND c.status <> 'anonymized'
    ) x
   WHERE x.v IS NOT NULL AND length(x.v) >= 4
), kept AS (
  SELECT 'platform_audit_event' AS store, e.event_id AS row_id,
         CASE WHEN c.client_id IS NULL THEN concat_ws(E'\n', e.actor_id, e.resource, e.result, e.reason, e.request_id, e.tenant_id)
              ELSE concat_ws(E'\n', e.actor_id, e.result) END AS txt
    FROM platform_audit_event e LEFT JOIN client c ON c.client_id = e.tenant_id
  UNION ALL
  SELECT 'audit_event', a.event_id::text, a.result FROM audit_event a WHERE a.result IS NOT NULL
  UNION ALL
  SELECT 'ai_manual_review', m.review_id, m.notes FROM ai_manual_review m
  UNION ALL
  SELECT 'ai_budget', b.scope, b.source FROM ai_budget b WHERE b.tenant_id IS NULL AND b.source IS NOT NULL
  UNION ALL
  SELECT 'plan_catalog_event', p.event_id, concat_ws(E'\n', p.actor_id, p.reason, p.diff::text, p.request_id) FROM plan_catalog_event p
  UNION ALL
  SELECT 'plan_revision', r.revision_id, concat_ws(E'\n', r.reason, r.publish_reason, r.created_by, r.published_by) FROM plan_revision r
)
SELECT COALESCE(k.store, 'TOTAL') AS store,
       count(DISTINCT k.store || ':' || k.row_id) AS rows_naming_a_tenant,
       count(DISTINCT p.tenant_id) AS tenants_whose_anonymization_would_fail
  FROM kept k JOIN pat p ON k.txt ~ p.re
 GROUP BY GROUPING SETS ((k.store), ())
 ORDER BY GROUPING(k.store), k.store;
\else
WITH pat AS (
  SELECT DISTINCT x.tenant_id,
         '(^|[^A-Za-z0-9_-])' || regexp_replace(x.v, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '([^A-Za-z0-9_-]|$)' AS re
    FROM (
      SELECT c.client_id AS tenant_id, btrim(c.client_id) AS v FROM client c WHERE c.status <> 'anonymized'
      UNION ALL SELECT c.client_id, btrim(c.contact_email) FROM client c WHERE c.status <> 'anonymized'
      UNION ALL SELECT u.tenant_id, btrim(u.user_id) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT u.tenant_id, btrim(u.login) FROM internal_user u JOIN client c ON c.client_id = u.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT w.tenant_id, btrim(w.slug) FROM client_website w JOIN client c ON c.client_id = w.tenant_id AND c.status <> 'anonymized'
      UNION ALL SELECT d.tenant_id, btrim(d.subdomain) FROM client_domain d JOIN client c ON c.client_id = d.tenant_id AND c.status <> 'anonymized'
    ) x
   WHERE x.v IS NOT NULL AND length(x.v) >= 4
), kept AS (
  SELECT 'platform_audit_event' AS store, e.event_id AS row_id,
         CASE WHEN c.client_id IS NULL THEN concat_ws(E'\n', e.actor_id, e.resource, e.result, e.reason, e.request_id, e.tenant_id)
              ELSE concat_ws(E'\n', e.actor_id, e.result) END AS txt
    FROM platform_audit_event e LEFT JOIN client c ON c.client_id = e.tenant_id
  UNION ALL
  SELECT 'audit_event', a.event_id::text, a.result FROM audit_event a WHERE a.result IS NOT NULL
  UNION ALL
  SELECT 'ai_manual_review', m.review_id, m.notes FROM ai_manual_review m
  UNION ALL
  SELECT 'ai_budget', b.scope, b.source FROM ai_budget b WHERE b.tenant_id IS NULL AND b.source IS NOT NULL
)
SELECT COALESCE(k.store, 'TOTAL') AS store,
       count(DISTINCT k.store || ':' || k.row_id) AS rows_naming_a_tenant,
       count(DISTINCT p.tenant_id) AS tenants_whose_anonymization_would_fail
  FROM kept k JOIN pat p ON k.txt ~ p.re
 GROUP BY GROUPING SETS ((k.store), ())
 ORDER BY GROUPING(k.store), k.store;
\endif
COMMIT;
