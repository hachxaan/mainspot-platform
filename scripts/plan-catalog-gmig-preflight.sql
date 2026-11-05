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
 -- 0034 creates objects with IF NOT EXISTS (and checks constraints by name only): any leftover object with one of
 -- its names would be silently adopted with whatever shape or table it has. Every named object of 0034 is listed.
 IF EXISTS (SELECT 1 FROM pg_class
             WHERE relnamespace = 'public'::regnamespace
               AND relname IN ('plan_parameter_definition', 'plan_parameter_value', 'plan_catalog_event', 'subscription_history',
                               'plan_limit_legacy_0009', 'uq_plan_name_lower', 'idx_quota_reservation_committed',
                               'uq_plan_revision_one_draft', 'uq_plan_revision_one_published', 'idx_plan_catalog_event_plan',
                               'idx_subscription_history_tenant'))
    OR EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND ((table_name = 'plan' AND column_name IN ('created_by', 'updated_at'))
                    OR (table_name = 'subscription' AND column_name = 'plan_revision_id')))
    OR EXISTS (SELECT 1 FROM pg_constraint
                WHERE connamespace = 'public'::regnamespace
                  AND conname IN ('quota_reservation_capability_fk', 'subscription_plan_revision_fk'))
    OR EXISTS (SELECT 1 FROM pg_proc
                WHERE pronamespace = 'public'::regnamespace
                  AND proname IN ('plan_revision_checksum', 'plan_revision_guard', 'plan_parameter_value_guard',
                                  'subscription_history_guard', 'subscription_assignment_guard', 'subscription_history_record',
                                  'plan_enabled_requires_published'))
    OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
                  AND t.tgname IN ('trg_plan_catalog_event_immutable', 'trg_plan_catalog_event_no_truncate', 'trg_plan_revision_guard',
                                   'trg_plan_revision_no_truncate', 'trg_plan_parameter_value_guard', 'trg_plan_parameter_value_no_truncate',
                                   'trg_subscription_history_guard', 'trg_subscription_history_no_truncate', 'trg_subscription_history',
                                   'trg_subscription_assignment_guard', 'trg_plan_enabled_published', 'trg_plan_revision_enabled_published',
                                   'trg_plan_limit_legacy_readonly', 'trg_plan_limit_legacy_no_truncate')) THEN
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
