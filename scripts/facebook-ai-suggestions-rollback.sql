-- MainSpot DEC-0078 (SRC-0018, SRC-0019) — REVERSIÓN de migrations/0038_facebook_ai_suggestions.sql ÚNICAMENTE.
-- No revierte 0037: el orden completo es 0040 → 0039 → 0038 (este script) → 0037 (consent-approval-binding-rollback.sql).
--
-- EXIGE EL CÓDIGO ANTERIOR (PR #18/#19 con la integración de los botones de Telegram, `3d00e3e` o equivalente)
-- desplegado junto con este cambio. Ese código redacta con IA todo comentario de Facebook que Jev lee (sin modos ni
-- medidor propio): solo sirve para volver a un estado de laboratorio; nunca para producción.
--
-- Uso, con la aplicación y los workers DETENIDOS y una copia de seguridad reciente (ON_ERROR_STOP: cualquier aborto
-- sale con código distinto de 0):
--   psql "$DATABASE_URL" -X -f scripts/facebook-ai-suggestions-rollback.sql
-- Es una sola transacción: ante cualquier error no cambia nada. Aborta sin tocar nada (SQLSTATE 55000) si 0038 no
-- está registrada, si hay migraciones posteriores registradas, si existe alguna configuración de sugerencias (es la
-- prueba de qué modo eligió y qué aceptó cada negocio), algún valor del medidor en una revisión de plan o alguna
-- reserva del medidor (uso medido). En ese caso, restaurar una copia de seguridad o corregir hacia delante.
--
-- Resultado: desaparecen engagement_suggestion_setting (con su trigger y función) y la definición
-- quota.ai_facebook_suggestions.max; las definiciones vuelven al registro 2; schema_migrations olvida 0038.

\set ON_ERROR_STOP on
-- READ COMMITTED explícito: la comprobación debe ver los datos posteriores al LOCK de abajo.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '15s';
DO $$
DECLARE
  settings INT;
  plan_values INT;
  reservations INT;
BEGIN
  -- Mismo candado que scripts/migrate.ts: nunca en paralelo con una migración.
  PERFORM pg_advisory_xact_lock(hashtext('mainspot_migrations'));
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file = '0038_facebook_ai_suggestions.sql') THEN
    RAISE EXCEPTION 'facebook-ai-suggestions-rollback: migration 0038 is not applied in this database; nothing to revert'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Nadie puede cambiar el modo, publicar una revisión con el medidor ni reservar entre la comprobación y el cambio.
  LOCK TABLE engagement_suggestion_setting, plan_parameter_definition, plan_parameter_value, quota_reservation IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0038_facebook_ai_suggestions.sql') THEN
    RAISE EXCEPTION 'facebook-ai-suggestions-rollback: migrations after 0038 are applied; review and revert them first'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO settings FROM engagement_suggestion_setting;
  SELECT count(*) INTO plan_values FROM plan_parameter_value WHERE parameter_key = 'quota.ai_facebook_suggestions.max';
  SELECT count(*) INTO reservations FROM quota_reservation WHERE capability = 'ai_facebook_suggestions';
  IF settings > 0 OR plan_values > 0 OR reservations > 0 THEN
    RAISE EXCEPTION 'facebook-ai-suggestions-rollback BLOCKED: % suggestion setting(s), % plan value(s) and % reservation(s) use 0038; reverting would delete the evidence of what each business chose and used. Restore a backup or fix forward.', settings, plan_values, reservations
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

DROP TRIGGER trg_engagement_suggestion_setting_guard ON engagement_suggestion_setting;
DROP FUNCTION engagement_suggestion_setting_guard();
DROP TABLE engagement_suggestion_setting;

DELETE FROM plan_parameter_definition WHERE parameter_key = 'quota.ai_facebook_suggestions.max';
UPDATE plan_parameter_definition SET registry_version = 2
 WHERE parameter_key IN ('quota.website.max', 'quota.social_posts.max', 'quota.social_ads.max', 'quota.reviews_managed.max',
                         'quota.ai_review_replies.max', 'quota.conversations.max', 'quota.agents.max');

DELETE FROM schema_migrations WHERE file = '0038_facebook_ai_suggestions.sql';
COMMIT;
