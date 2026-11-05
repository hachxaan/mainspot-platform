-- G-SEC/R1 read-only preflight, run BEFORE any legacy audit repair or migration outside development.
--   psql "$DATABASE_URL" -X -f scripts/plan-catalog-legacy-audit-preflight.sql
-- Only aggregate counts: no tenant identifier, login or event ID is emitted. Same predicates as
-- scripts/plan-catalog-legacy-audit-repair.sql. This does not authorize the repair. It approximates the
-- anonymization verification for the stores below; the definitive check is scripts/anonymization-dry-run.ts on a
-- restored copy.
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
-- identifier boundary of assertNoTraces; `ident` lets a cheap strpos() run before the regex. A cell blocks when
-- anonymization cannot remove it: rows without an existing tenant, any cell; rows of a tenant, the cells it keeps
-- (any tenant's identifier) and the cells it clears (only OTHER tenants' identifiers, until that tenant goes).
-- 2a. platform_audit_event outside the repair's contract (the repair refuses while any exists). Clear legacy logins
-- are listed apart: REDACT_LEGACY_LOGIN_ACTORS=1 rewrites them; without it they block when they name a tenant.
WITH pat AS (
  SELECT DISTINCT x.tenant_id, x.v AS ident,
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
), cell AS (
  SELECT e.event_id, c.client_id AS bound_to, v.col, v.kept, v.val,
         CASE WHEN v.col = 'actor_id' AND e.action = 'platform.login' AND e.decision = 'deny' AND e.actor_id LIKE 'login:%'
                   AND e.actor_id !~ '^login:([0-9a-f]{64}|unknown|legacy-redacted)$' THEN 'legacy_clear_login'
              ELSE CASE WHEN c.client_id IS NULL THEN 'unbound.' ELSE 'bound.' END || v.col END AS kind,
         (e.tenant_id IS NULL AND e.decision = 'deny'
          AND e.resource ~* '^(/api/platform)?/tenants/[^/]+(/(plan|status|data-classification|support-access|support-view))?/?$'
          AND e.resource !~* '^(/api/platform)?/tenants/:id(/|$)') AS candidate
    FROM platform_audit_event e
    LEFT JOIN client c ON c.client_id = e.tenant_id
   CROSS JOIN LATERAL (VALUES
     ('actor_id', true, e.actor_id), ('result', true, e.result),
     ('resource', false, e.resource), ('reason', false, e.reason), ('request_id', false, e.request_id),
     ('tenant_id', false, CASE WHEN c.client_id IS NULL THEN e.tenant_id END)) AS v(col, kept, val)
   WHERE v.val IS NOT NULL
)
SELECT x.kind AS out_of_contract_kind, count(DISTINCT x.event_id) AS rows_naming_a_tenant
  FROM cell x
 WHERE NOT (x.col = 'resource' AND x.candidate)
   AND EXISTS (SELECT 1 FROM pat p
                WHERE CASE WHEN strpos(x.val, p.ident) > 0 THEN x.val ~ p.re ELSE false END
                  AND (x.bound_to IS NULL OR x.kept OR p.tenant_id <> x.bound_to))
 GROUP BY x.kind ORDER BY x.kind;

-- 2b. Informational: rows without an existing tenant that mention a client_ id of no live tenant (typos, ids of
-- businesses already anonymized). They block no anonymization; the repair leaves them unchanged.
SELECT count(*) AS unbound_rows_with_client_id_of_no_live_tenant
  FROM platform_audit_event e
  LEFT JOIN client c ON c.client_id = e.tenant_id
 WHERE c.client_id IS NULL
   AND concat_ws(E'\n', e.actor_id, e.result, e.reason, e.request_id, e.tenant_id,
                 CASE WHEN NOT (e.tenant_id IS NULL AND e.decision = 'deny'
                      AND e.resource ~* '^(/api/platform)?/tenants/[^/]+(/(plan|status|data-classification|support-access|support-view))?/?$'
                      AND e.resource !~* '^(/api/platform)?/tenants/:id(/|$)') THEN e.resource END)
       ~ '(^|[^A-Za-z0-9_-])client_[A-Za-z0-9_-]+'
   AND NOT EXISTS (SELECT 1 FROM client live WHERE live.status <> 'anonymized'
                    AND strpos(concat_ws(E'\n', e.actor_id, e.result, e.reason, e.request_id, e.tenant_id, e.resource), live.client_id) > 0);

-- 2c. Anonymization blockers by store (DEC-0027), same rule. The TOTAL row counts distinct tenants. The catalog
-- stores exist only after 0034.
SELECT to_regclass('public.plan_catalog_event') IS NOT NULL AS preflight_has_plan_catalog \gset
\if :preflight_has_plan_catalog
WITH pat AS (
  SELECT DISTINCT x.tenant_id, x.v AS ident,
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
), cell AS (
  SELECT 'platform_audit_event' AS store, e.event_id AS row_id, c.client_id AS bound_to, v.kept, v.val
    FROM platform_audit_event e
    LEFT JOIN client c ON c.client_id = e.tenant_id
   CROSS JOIN LATERAL (VALUES (true, e.actor_id), (true, e.result), (false, e.resource), (false, e.reason), (false, e.request_id),
                              (false, CASE WHEN c.client_id IS NULL THEN e.tenant_id END)) AS v(kept, val)
  UNION ALL
  SELECT 'audit_event', a.event_id, a.tenant_id, v.kept, v.val
    FROM audit_event a
   CROSS JOIN LATERAL (VALUES (true, a.result), (false, a.actor_id), (false, a.resource), (false, a.request_id), (false, a.evidence_ref)) AS v(kept, val)
  UNION ALL
  SELECT 'ai_manual_review', m.review_id, NULL, true, m.notes FROM ai_manual_review m
  UNION ALL
  SELECT 'ai_budget', b.scope, NULL, true, b.source FROM ai_budget b WHERE b.tenant_id IS NULL
  UNION ALL
  SELECT 'plan_catalog_event', p.event_id, NULL, true, concat_ws(E'\n', p.actor_id, p.reason, p.diff::text, p.request_id) FROM plan_catalog_event p
  UNION ALL
  SELECT 'plan_revision', r.revision_id, NULL, true, concat_ws(E'\n', r.reason, r.publish_reason, r.created_by, r.published_by) FROM plan_revision r
), hit AS (
  SELECT DISTINCT x.store, x.row_id, p.tenant_id
    FROM cell x JOIN pat p ON CASE WHEN x.val IS NOT NULL AND strpos(x.val, p.ident) > 0 THEN x.val ~ p.re ELSE false END
   WHERE x.bound_to IS NULL OR x.kept OR p.tenant_id <> x.bound_to
)
SELECT COALESCE(h.store, 'TOTAL') AS store,
       count(DISTINCT h.store || ':' || h.row_id) AS rows_naming_a_tenant,
       count(DISTINCT h.tenant_id) AS tenants_whose_anonymization_would_fail
  FROM hit h
 GROUP BY GROUPING SETS ((h.store), ())
 ORDER BY GROUPING(h.store), h.store;
\else
WITH pat AS (
  SELECT DISTINCT x.tenant_id, x.v AS ident,
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
), cell AS (
  SELECT 'platform_audit_event' AS store, e.event_id AS row_id, c.client_id AS bound_to, v.kept, v.val
    FROM platform_audit_event e
    LEFT JOIN client c ON c.client_id = e.tenant_id
   CROSS JOIN LATERAL (VALUES (true, e.actor_id), (true, e.result), (false, e.resource), (false, e.reason), (false, e.request_id),
                              (false, CASE WHEN c.client_id IS NULL THEN e.tenant_id END)) AS v(kept, val)
  UNION ALL
  SELECT 'audit_event', a.event_id, a.tenant_id, v.kept, v.val
    FROM audit_event a
   CROSS JOIN LATERAL (VALUES (true, a.result), (false, a.actor_id), (false, a.resource), (false, a.request_id), (false, a.evidence_ref)) AS v(kept, val)
  UNION ALL
  SELECT 'ai_manual_review', m.review_id, NULL, true, m.notes FROM ai_manual_review m
  UNION ALL
  SELECT 'ai_budget', b.scope, NULL, true, b.source FROM ai_budget b WHERE b.tenant_id IS NULL
), hit AS (
  SELECT DISTINCT x.store, x.row_id, p.tenant_id
    FROM cell x JOIN pat p ON CASE WHEN x.val IS NOT NULL AND strpos(x.val, p.ident) > 0 THEN x.val ~ p.re ELSE false END
   WHERE x.bound_to IS NULL OR x.kept OR p.tenant_id <> x.bound_to
)
SELECT COALESCE(h.store, 'TOTAL') AS store,
       count(DISTINCT h.store || ':' || h.row_id) AS rows_naming_a_tenant,
       count(DISTINCT h.tenant_id) AS tenants_whose_anonymization_would_fail
  FROM hit h
 GROUP BY GROUPING SETS ((h.store), ())
 ORDER BY GROUPING(h.store), h.store;
\endif
COMMIT;
