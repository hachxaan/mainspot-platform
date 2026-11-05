-- G-MIG: read-only inventory and migration eligibility BEFORE 0034 in a target environment.
--   psql "$DATABASE_URL" -X -f scripts/plan-catalog-gmig-preflight.sql
-- Does NOT modify schema/data, verify backups, stop workers or grant approval. Exit status is non-zero when
-- 0034 would abort (or is already applied); the blocking checks are the same conditions that abort 0034.
-- Requires legacy schema containing plan_limit (0009) and quota_reservation (0014).
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$
BEGIN
 IF to_regclass('public.plan_revision') IS NOT NULL OR to_regclass('public.plan_limit') IS NULL THEN
   RAISE EXCEPTION 'G-MIG BLOCKED: 0034 appears applied (or plan_limit is missing); use scripts/plan-catalog-rollback-preflight.sql';
 END IF;
 -- 0034 uses IF NOT EXISTS: a leftover object with its name would be silently adopted with whatever shape it has.
 IF to_regclass('public.plan_parameter_definition') IS NOT NULL OR to_regclass('public.plan_parameter_value') IS NOT NULL
    OR to_regclass('public.plan_catalog_event') IS NOT NULL OR to_regclass('public.subscription_history') IS NOT NULL
    OR to_regclass('public.plan_limit_legacy_0009') IS NOT NULL OR to_regclass('public.uq_plan_name_lower') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'subscription' AND column_name = 'plan_revision_id') THEN
   RAISE EXCEPTION 'G-MIG BLOCKED: objects of 0034 already exist without plan_revision; inspect the schema manually';
 END IF;
END $$;
SELECT count(*) AS plan_count, count(*) FILTER (WHERE active) AS enabled_plans FROM plan;
SELECT status, count(*) AS subscription_count FROM subscription GROUP BY status ORDER BY status;
SELECT count(*) AS legacy_limits FROM plan_limit;
SELECT
  count(*) FILTER (WHERE l.capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations'))
    AS unknown_capabilities,
  count(*) FILTER (WHERE l.max_value < 0
     OR (l.capability='website' AND l.max_value>1)
     OR (l.capability<>'website' AND l.max_value>1000000)) AS incompatible_values
FROM plan_limit l;
SELECT lower(name) AS duplicate_normalized_name, count(*) AS n
  FROM plan GROUP BY lower(name) HAVING count(*) > 1;
SELECT count(*) AS subscriptions_without_existing_plan
  FROM subscription s LEFT JOIN plan p ON p.plan_id=s.plan_id WHERE p.plan_id IS NULL;
SELECT count(*) AS reservations_with_unknown_capability
  FROM quota_reservation q
 WHERE q.capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations');
SELECT p.plan_id, p.active, count(l.limit_id) AS explicit_capabilities,
       6-count(DISTINCT l.capability) AS currently_missing_capabilities_denied
FROM plan p LEFT JOIN plan_limit l ON l.plan_id=p.plan_id
GROUP BY p.plan_id, p.active ORDER BY p.plan_id;
DO $$
BEGIN
 -- Same conditions that abort 0034: values outside the registry (its value trigger) and duplicate names (uq_plan_name_lower).
 IF EXISTS (SELECT 1 FROM plan_limit l
     WHERE l.capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations')
        OR l.max_value < 0 OR (l.capability='website' AND l.max_value>1)
        OR (l.capability<>'website' AND l.max_value>1000000)) THEN
   RAISE EXCEPTION 'G-MIG BLOCKED: unknown/out-of-range existing plan limits';
 END IF;
 IF EXISTS (SELECT 1 FROM plan GROUP BY lower(name) HAVING count(*)>1) THEN
   RAISE EXCEPTION 'G-MIG BLOCKED: duplicate case-insensitive plan names';
 END IF;
 IF EXISTS (SELECT 1 FROM subscription s LEFT JOIN plan p ON p.plan_id=s.plan_id WHERE p.plan_id IS NULL) THEN
   RAISE EXCEPTION 'G-MIG BLOCKED: subscription references nonexisting plan';
 END IF;
 -- 0034 replaces the ledger CHECK with a FK to the registry: a drifted capability makes it abort.
 IF EXISTS (SELECT 1 FROM quota_reservation q
             WHERE q.capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations')) THEN
   RAISE EXCEPTION 'G-MIG BLOCKED: quota_reservation has capabilities outside the registry';
 END IF;
END $$;
COMMIT;
