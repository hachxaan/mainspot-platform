-- G-MIG: read-only inventory and migration eligibility BEFORE 0034 in a target environment.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/plan-catalog-gmig-preflight.sql
-- Does NOT modify schema/data, verify backups, stop workers or grant approval.
-- Requires legacy schema containing plan_limit (0009) and quota_reservation (0014).
BEGIN READ ONLY;
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
 IF to_regclass('public.plan_revision') IS NOT NULL THEN
   RAISE EXCEPTION 'G-MIG BLOCKED: 0034 appears applied; run the post-migration gate instead';
 END IF;
END $$;
COMMIT;
