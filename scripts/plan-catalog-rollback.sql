-- MainSpot DEC-0075 (SRC-0013) — REVERSIÓN de migrations/0034_plan_policy_catalog.sql a la forma 0009/0014.
--
-- EXIGE EL CÓDIGO ANTERIOR: tras revertir hay que desplegar el código previo al catálogo versionado
-- (base 95f9436 o equivalente). El código del catálogo versionado NO funciona sobre el esquema revertido
-- (sus tablas, la columna subscription.plan_revision_id y sus triggers desaparecen).
--
-- Uso, con la aplicación y los workers DETENIDOS y una copia de seguridad reciente:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/plan-catalog-rollback.sql
-- Es una sola transacción (BEGIN … COMMIT): ante cualquier error no cambia nada. Aborta sin tocar nada si
-- 0034 no está aplicada, si hay migraciones posteriores a 0034 registradas (revisarlas y revertirlas
-- antes) o si quota_reservation tiene capacidades fuera de la lista de 0014 (no caben en su CHECK).
--
-- Fail-closed: the rollback ABORTS (SQLSTATE 55000) when any subscription is pinned to a
-- SUPERSEDED or otherwise non-current revision. The old schema cannot express per-tenant pins.
-- Do not migrate subscribers merely to make the rollback pass without an owner decision.
--
-- Resultado:
--   - plan_limit vuelve (es plan_limit_legacy_0009 renombrada, sin sus triggers de solo lectura y de TRUNCATE)
--     con sus filas REGENERADAS desde la revisión PUBLISHED vigente de cada plan: una fila por capacidad de
--     0014 con su valor publicado. Una fila que ya existía conserva su limit_id; un valor `backfill_absent_deny`
--     (capacidad sin fila en 0009) vuelve a ser ausencia (el mismo deny). Un plan sin revisión publicada queda
--     sin filas (deny total). Si el catálogo no cambió desde 0034, plan_limit queda idéntica a la de antes de migrar.
--   - quota_reservation recupera el CHECK de capacidades de 0014 (sin la FK al registro ni el índice de
--     unidades confirmadas); sus filas no cambian.
--   - subscription pierde plan_revision_id; plan pierde created_by y updated_at; desaparecen
--     plan_parameter_definition, plan_revision, plan_parameter_value, plan_catalog_event,
--     subscription_history y los triggers y funciones de 0034.
--   - permission recupera las descripciones de 0009; schema_migrations olvida 0034 (puede reaplicarse).
--
-- SE PIERDE (solo recuperable desde la copia de seguridad):
--   - el historial de revisiones (borradores, publicadas, SUPERSEDED, DISCARDED), sus valores con
--     confirmación individual, sus huellas y la auditoría detallada del catálogo (plan_catalog_event);
--   - la fijación por revisión: cada suscripción pasa a los valores PUBLICADOS de su plan; una suscripción
--     fijada a una revisión no vigente cambia de límites (se avisa con un NOTICE con el recuento);
--   - el historial de asignaciones (subscription_history) y el autor y la fecha de cambio de cada plan;
--   - los valores de parámetros sin capacidad de 0014 (no existen en la forma 0009).
-- La auditoría general (audit_event, platform_audit_event) no se toca.

BEGIN;
SET LOCAL lock_timeout = '15s';
DO $$
DECLARE
  foreign_caps TEXT;
  unpinned INT;
BEGIN
  -- Mismo candado que scripts/migrate.ts: nunca en paralelo con una migración.
  PERFORM pg_advisory_xact_lock(hashtext('mainspot_migrations'));
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file = '0034_plan_policy_catalog.sql')
     OR to_regclass('public.plan_revision') IS NULL
     OR to_regclass('public.plan_limit_legacy_0009') IS NULL
     OR to_regclass('public.plan_limit') IS NOT NULL THEN
    RAISE EXCEPTION 'plan-catalog-rollback: migration 0034 is not applied in this database; nothing to revert'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0034_plan_policy_catalog.sql') THEN
    RAISE EXCEPTION 'plan-catalog-rollback: migrations after 0034 are applied; review and revert them first'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT string_agg(DISTINCT capability, ', ' ORDER BY capability) INTO foreign_caps
    FROM quota_reservation
   WHERE capability NOT IN ('website','social_posts','social_ads','reviews_managed','agents','conversations');
  IF foreign_caps IS NOT NULL THEN
    RAISE EXCEPTION 'plan-catalog-rollback: quota_reservation has capabilities outside migration 0014 (%); rollback aborted', foreign_caps
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO unpinned
    FROM subscription s JOIN plan_revision r ON r.revision_id = s.plan_revision_id
   WHERE r.status <> 'PUBLISHED';
  IF unpinned > 0 THEN
    RAISE EXCEPTION 'plan-catalog-rollback BLOCKED: % subscription(s) pinned to non-current revisions; reverting would silently change entitlements. Migrate explicitly with owner approval or restore a backup.', unpinned
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

-- ---------------------------------------------------------------- suscripción: sin fijación ni historial
DROP TRIGGER trg_subscription_assignment_guard ON subscription;
DROP TRIGGER trg_subscription_history ON subscription;
ALTER TABLE subscription DROP CONSTRAINT subscription_plan_revision_fk;
ALTER TABLE subscription DROP COLUMN plan_revision_id;
DROP TABLE subscription_history;
DROP FUNCTION subscription_assignment_guard();
DROP FUNCTION subscription_history_record();
DROP FUNCTION subscription_history_guard();

-- ---------------------------------------------------------------- plan: sin el invariante habilitado ⇒ publicada
DROP TRIGGER trg_plan_enabled_published ON plan;
DROP TRIGGER trg_plan_revision_enabled_published ON plan_revision;
DROP FUNCTION plan_enabled_requires_published();

-- ---------------------------------------------------------------- plan_limit: valores PUBLICADOS vigentes
DROP TRIGGER trg_plan_limit_legacy_readonly ON plan_limit_legacy_0009;
DROP TRIGGER trg_plan_limit_legacy_no_truncate ON plan_limit_legacy_0009;
ALTER TABLE plan_limit_legacy_0009 RENAME TO plan_limit;

CREATE TEMP TABLE plan_limit_published_0034 ON COMMIT DROP AS
SELECT r.plan_id, d.capability, v.value_int AS max_value
  FROM plan_revision r
  JOIN plan_parameter_value v ON v.revision_id = r.revision_id
  JOIN plan_parameter_definition d ON d.parameter_key = v.parameter_key
 WHERE r.status = 'PUBLISHED'
   AND d.value_type = 'int'
   AND d.capability IN ('website','social_posts','social_ads','reviews_managed','agents','conversations')
   AND v.value_int IS NOT NULL
   AND v.source <> 'backfill_absent_deny';

DELETE FROM plan_limit l
 WHERE NOT EXISTS (SELECT 1 FROM plan_limit_published_0034 p WHERE p.plan_id = l.plan_id AND p.capability = l.capability);
UPDATE plan_limit l SET max_value = p.max_value
  FROM plan_limit_published_0034 p
 WHERE p.plan_id = l.plan_id AND p.capability = l.capability AND l.max_value <> p.max_value;
INSERT INTO plan_limit (limit_id, plan_id, capability, max_value)
SELECT 'limit_rb0034_' || p.plan_id || '_' || p.capability, p.plan_id, p.capability, p.max_value
  FROM plan_limit_published_0034 p
 WHERE NOT EXISTS (SELECT 1 FROM plan_limit l WHERE l.plan_id = p.plan_id AND l.capability = p.capability);

-- ---------------------------------------------------------------- libro de cuotas: CHECK de 0014
ALTER TABLE quota_reservation DROP CONSTRAINT quota_reservation_capability_fk;
DROP INDEX idx_quota_reservation_committed;
ALTER TABLE quota_reservation ADD CONSTRAINT quota_reservation_capability_check
  CHECK (capability IN ('website','social_posts','social_ads','reviews_managed','agents','conversations'));

-- ---------------------------------------------------------------- catálogo versionado
DROP TABLE plan_catalog_event;
DROP TABLE plan_parameter_value;
DROP TABLE plan_revision;
DROP TABLE plan_parameter_definition;
DROP FUNCTION plan_parameter_value_guard();
DROP FUNCTION plan_revision_guard();
DROP FUNCTION plan_revision_checksum(TEXT);

DROP INDEX uq_plan_name_lower;
ALTER TABLE plan DROP COLUMN created_by, DROP COLUMN updated_at;

-- ---------------------------------------------------------------- permisos del negocio (textos de 0009)
UPDATE permission SET description = 'Asignar el plan de suscripción del cliente y gestionar su facturación'
 WHERE permission_id = 'subscription.admin';
UPDATE permission SET description = 'Ver el plan y los límites del cliente' WHERE permission_id = 'subscription.read';

DELETE FROM schema_migrations WHERE file = '0034_plan_policy_catalog.sql';

COMMIT;
