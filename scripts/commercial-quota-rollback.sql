-- MainSpot DEC-0076 (SRC-0014) — REVERSIÓN de migrations/0036_commercial_quota_semantics.sql ÚNICAMENTE.
-- No revierte 0035 ni 0034: el orden completo es 0036 (este script) → 0035 (plan-catalog-hardening-rollback.sql)
-- → 0034 (plan-catalog-rollback.sql).
--
-- EXIGE EL CÓDIGO ANTERIOR (registro de parámetros v1, PR #14 `f68746b` o equivalente) desplegado junto con este
-- cambio: con el código de DEC-0076 sobre el esquema revertido, el espejo del registro no coincide y las escrituras
-- del catálogo responden 503.
--
-- Uso, con la aplicación y los workers DETENIDOS y una copia de seguridad reciente (el script impone ON_ERROR_STOP:
-- cualquier aborto sale con código distinto de 0):
--   psql "$DATABASE_URL" -X -f scripts/commercial-quota-rollback.sql
-- Es una sola transacción: ante cualquier error no cambia nada. Aborta sin tocar nada (SQLSTATE 55000) si 0036 no
-- está registrada, si hay migraciones posteriores registradas o si algún valor de revisión (borrador, publicada o
-- descartada), alguna reserva del libro de cuotas o alguna propuesta `engagement_case.ai_draft` usa la cuota nueva:
-- esos registros son inmutables, consumo real del negocio o texto pagado, y revertir los borraría o los dejaría
-- huérfanos. En ese caso, restaurar una copia de seguridad o corregir hacia delante.
--
-- Resultado: desaparece la definición `quota.ai_review_replies.max` y la columna `engagement_case.ai_draft`;
-- `quota.reviews_managed.max` vuelve a `enforced` con su descripción de 0034 (el código anterior vuelve a consumirla
-- al sincronizar); todas las definiciones vuelven a registry_version 1; schema_migrations olvida 0036 (puede reaplicarse).

\set ON_ERROR_STOP on
-- READ COMMITTED explícito: la comprobación debe ver los datos posteriores al LOCK de abajo.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '15s';
DO $$
DECLARE
  value_rows INT;
  ledger_rows INT;
  draft_rows INT;
BEGIN
  -- Mismo candado que scripts/migrate.ts: nunca en paralelo con una migración.
  PERFORM pg_advisory_xact_lock(hashtext('mainspot_migrations'));
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file = '0036_commercial_quota_semantics.sql') THEN
    RAISE EXCEPTION 'commercial-quota-rollback: migration 0036 is not applied in this database; nothing to revert'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Nadie puede crear borradores, escribir valores ni reservar entre la comprobación y el cambio.
  LOCK TABLE plan_parameter_definition, plan_parameter_value, quota_reservation, engagement_case IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0036_commercial_quota_semantics.sql') THEN
    RAISE EXCEPTION 'commercial-quota-rollback: migrations after 0036 are applied; review and revert them first'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO value_rows FROM plan_parameter_value WHERE parameter_key = 'quota.ai_review_replies.max';
  SELECT count(*) INTO ledger_rows FROM quota_reservation WHERE capability = 'ai_review_replies';
  SELECT count(*) INTO draft_rows FROM engagement_case WHERE ai_draft IS NOT NULL;
  IF value_rows > 0 OR ledger_rows > 0 OR draft_rows > 0 THEN
    RAISE EXCEPTION 'commercial-quota-rollback BLOCKED: % plan revision value(s), % quota ledger row(s) and % AI draft(s) use ai_review_replies; reverting would delete immutable history, paid text or orphan real consumption. Restore a backup or fix forward.', value_rows, ledger_rows, draft_rows
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

ALTER TABLE engagement_case DROP CONSTRAINT engagement_case_ai_draft_check;
ALTER TABLE engagement_case DROP COLUMN ai_draft;

DELETE FROM plan_parameter_definition WHERE parameter_key = 'quota.ai_review_replies.max';

UPDATE plan_parameter_definition
   SET description = 'Reseñas que MainSpot puede ingerir y gestionar. Cuenta todas las reseñas ingeridas durante toda la suscripción; cada sincronización consume el lote completo o nada.',
       enforcement_state = 'enforced'
 WHERE parameter_key = 'quota.reviews_managed.max';

UPDATE plan_parameter_definition SET registry_version = 1
 WHERE parameter_key IN ('quota.website.max', 'quota.social_posts.max', 'quota.social_ads.max', 'quota.reviews_managed.max',
                         'quota.conversations.max', 'quota.agents.max');

DELETE FROM schema_migrations WHERE file = '0036_commercial_quota_semantics.sql';
COMMIT;
