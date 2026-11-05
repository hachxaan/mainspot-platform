-- G-MIG: read-only preflight BEFORE rolling back 0034. Requires 0034 applied.
-- Only aggregate counts; the operation itself must not proceed without human authorization.
BEGIN READ ONLY;
SELECT
  count(*) AS subscriptions,
  count(*) FILTER (WHERE r.status='SUPERSEDED') AS pinned_to_superseded_revision,
  count(*) FILTER (WHERE r.status='PUBLISHED') AS pinned_to_current_revision,
  count(*) FILTER (WHERE r.status NOT IN ('PUBLISHED','SUPERSEDED')) AS inconsistent_pins
FROM subscription s JOIN plan_revision r ON r.revision_id=s.plan_revision_id;
SELECT count(*) AS capabilities_not_supported_by_0014
  FROM quota_reservation
 WHERE capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations');
SELECT count(*) AS later_migrations
  FROM schema_migrations WHERE file COLLATE "C" > '0034_plan_policy_catalog.sql';
COMMIT;
