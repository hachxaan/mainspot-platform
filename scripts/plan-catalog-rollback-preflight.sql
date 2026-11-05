-- G-MIG: read-only preflight BEFORE rolling back 0034 (scripts/plan-catalog-rollback.sql). Requires 0034 applied.
--   psql "$DATABASE_URL" -X -f scripts/plan-catalog-rollback-preflight.sql
-- Only aggregate counts. The verdict row evaluates the SAME conditions that make the rollback abort, and the
-- script exits non-zero when any holds. It does not authorize anything: the rollback itself needs the owner's
-- decision, stopped writers and a restorable backup. Counts can change until writers are stopped.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$
BEGIN
  IF to_regclass('public.plan_revision') IS NULL OR to_regclass('public.plan_limit_legacy_0009') IS NULL THEN
    RAISE EXCEPTION 'G-MIG: migration 0034 is not applied in this database; nothing to roll back';
  END IF;
END $$;
SELECT
  count(*) AS subscriptions,
  count(*) FILTER (WHERE r.status = 'PUBLISHED') AS pinned_to_current_revision,
  count(*) FILTER (WHERE r.status = 'SUPERSEDED') AS pinned_to_superseded_revision,
  count(*) FILTER (WHERE r.status IS NULL OR r.status NOT IN ('PUBLISHED','SUPERSEDED')) AS inconsistent_pins
FROM subscription s LEFT JOIN plan_revision r ON r.revision_id = s.plan_revision_id AND r.plan_id = s.plan_id;
SELECT count(*) AS capabilities_not_supported_by_0014
  FROM quota_reservation
 WHERE capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations');
SELECT count(*) AS later_migrations
  FROM schema_migrations WHERE file COLLATE "C" > '0034_plan_policy_catalog.sql';
SELECT
  NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file = '0034_plan_policy_catalog.sql') AS blocked_0034_not_registered,
  EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0034_plan_policy_catalog.sql') AS blocked_later_migrations,
  EXISTS (SELECT 1 FROM quota_reservation
           WHERE capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations'))
    AS blocked_foreign_capabilities,
  EXISTS (SELECT 1 FROM subscription s
           WHERE NOT EXISTS (SELECT 1 FROM plan_revision r
                              WHERE r.revision_id = s.plan_revision_id AND r.plan_id = s.plan_id AND r.status = 'PUBLISHED'))
    AS blocked_non_current_pins
\gset preflight_
\if :preflight_blocked_0034_not_registered
  \echo 'G-MIG ROLLBACK BLOCKED: 0034 is not registered in schema_migrations'
\endif
\if :preflight_blocked_later_migrations
  \echo 'G-MIG ROLLBACK BLOCKED: migrations after 0034 are registered (revert 0035 first: scripts/plan-catalog-hardening-rollback.sql)'
\endif
\if :preflight_blocked_foreign_capabilities
  \echo 'G-MIG ROLLBACK BLOCKED: quota_reservation has capabilities outside 0014'
\endif
\if :preflight_blocked_non_current_pins
  \echo 'G-MIG ROLLBACK BLOCKED: subscriptions pinned to a revision that is not the published one of their plan (owner decision)'
\endif
SELECT :'preflight_blocked_0034_not_registered' AS blocked_0034_not_registered,
       :'preflight_blocked_later_migrations' AS blocked_later_migrations,
       :'preflight_blocked_foreign_capabilities' AS blocked_foreign_capabilities,
       :'preflight_blocked_non_current_pins' AS blocked_non_current_pins;
COMMIT;
\if :preflight_blocked_0034_not_registered
  SELECT 1/0 AS rollback_would_abort;
\elif :preflight_blocked_later_migrations
  SELECT 1/0 AS rollback_would_abort;
\elif :preflight_blocked_foreign_capabilities
  SELECT 1/0 AS rollback_would_abort;
\elif :preflight_blocked_non_current_pins
  SELECT 1/0 AS rollback_would_abort;
\endif
