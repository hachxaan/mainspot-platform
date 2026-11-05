-- G-SEC/R1 read-only preflight, run BEFORE any legacy audit repair or migration outside development.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/plan-catalog-legacy-audit-preflight.sql
-- No raw tenant identifiers are emitted. This does not authorize the repair.
BEGIN READ ONLY;
SELECT
  count(*) FILTER (
    WHERE tenant_id IS NULL AND decision = 'deny'
      AND resource ~ '^(/api/platform)?/tenants/[^/?#]+(/(plan|status|data-classification|support-access|support-view))?$'
  ) AS legacy_denials_eligible_for_targeted_repair,
  count(*) FILTER (
    WHERE tenant_id IS NULL AND resource ~ 'client_[[:alnum:]_-]+'
      AND resource !~ '^(/api/platform)?/tenants/[^/?#]+(/(plan|status|data-classification|support-access|support-view))?$'
  ) AS other_unbound_resources_with_client_ids_to_investigate,
  count(*) FILTER (WHERE tenant_id IS NULL AND reason ~ 'client_[[:alnum:]_-]+')
    AS unbound_reasons_with_client_ids_to_investigate,
  count(*) FILTER (WHERE tenant_id IS NULL AND result ~ 'client_[[:alnum:]_-]+')
    AS unbound_results_with_client_ids_to_investigate
FROM platform_audit_event;
SELECT action, count(*) AS candidate_rows
  FROM platform_audit_event
 WHERE tenant_id IS NULL AND decision = 'deny'
   AND resource ~ '^(/api/platform)?/tenants/[^/?#]+(/(plan|status|data-classification|support-access|support-view))?$'
 GROUP BY action ORDER BY action;
COMMIT;
