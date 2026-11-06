-- MainSpot DEC-0078 (SRC-0018 = SRC-007 del propietario; SRC-0019) — IA de comentarios de Facebook: modos de sugerencias
-- y medidor propio. Migración ADITIVA y transaccional (el runner ejecuta el archivo completo en una transacción).
-- Re-ejecutable: aplicarla de nuevo sobre un esquema ya migrado no cambia nada.
--
--   1. quota.ai_facebook_suggestions.max (registro de parámetros v3): cuota PERIÓDICA por ciclo mensual de la suscripción
--      (UTC, sin acumulación) de comentarios de Facebook con texto preparado por IA (sugerencia para revisar o respuesta
--      automática autorizada), como máximo 1 por comentario. Nunca hereda `ai_review_replies` (reseñas de Google).
--      Ninguna revisión publicada la define: hasta publicar una revisión nueva con un valor que decida el propietario, la
--      IA de pago para comentarios de Facebook se deniega (fail-closed). Activación comercial BLOCKED (DEC-0078 R5).
--   2. registry_version = 3 en todas las definiciones (espejo de PLAN_REGISTRY_VERSION).
--   3. engagement_suggestion_setting: modo de sugerencias con IA por negocio y origen (off | on_demand | auto_suggest),
--      append-only y versionado. `auto_suggest` (y solo él) guarda el texto literal aceptado, su versión y su huella
--      (SEC-CONSENT-01); la BD rechaza una huella que no sea la del texto y cualquier UPDATE. Sin fila, el modo efectivo
--      es `on_demand` (predeterminado de DEC-0078 R1). El modo nunca autoriza publicar: eso sigue en engagement_policy.
-- No toca revisiones, valores, suscripciones, políticas, casos ni el libro de cuotas. Sin precios ni cobros.
-- Reversión (solo mientras ninguna configuración, valor ni reserva use lo nuevo): scripts/facebook-ai-suggestions-rollback.sql.

INSERT INTO plan_parameter_definition
  (parameter_key, capability, category, label, description, unit, value_type, semantics, period_kind, window_seconds,
   min_value, max_value, ceiling_reason, suggested_int, suggested_bool, enforcement_state, registry_version, sort_order) VALUES
  ('quota.ai_facebook_suggestions.max', 'ai_facebook_suggestions', 'Redes sociales', 'Sugerencias con IA para comentarios de Facebook',
   'Comentarios de Facebook para los que MainSpot prepara un texto con IA (sugerencia para revisar o respuesta automática autorizada) en cada ciclo mensual de la suscripción (anclado a su inicio, UTC). Cada comentario consume como máximo 1 al generarse el texto, aunque no se publique; recibir comentarios, responder a mano y las propuestas sin IA no consumen. Lo no usado no se acumula. No usa las respuestas con IA de reseñas de Google.',
   'sugerencias', 'int', 'periodic', 'subscription_month', NULL, 0, 1000000,
   'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).',
   0, NULL, 'enforced', 3, 47)
ON CONFLICT (parameter_key) DO NOTHING;

UPDATE plan_parameter_definition SET registry_version = 3
 WHERE parameter_key IN ('quota.website.max', 'quota.social_posts.max', 'quota.social_ads.max', 'quota.reviews_managed.max',
                         'quota.ai_review_replies.max', 'quota.ai_facebook_suggestions.max', 'quota.conversations.max', 'quota.agents.max');

-- Defensa: si la definición ya existía con otra forma (p. ej. creada a mano), abortar en vez de dejar un espejo
-- incoherente con el registro.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_parameter_definition
                  WHERE parameter_key = 'quota.ai_facebook_suggestions.max' AND capability = 'ai_facebook_suggestions'
                    AND value_type = 'int' AND semantics = 'periodic' AND period_kind = 'subscription_month'
                    AND min_value = 0 AND max_value = 1000000 AND suggested_int = 0 AND enforcement_state = 'enforced') THEN
    RAISE EXCEPTION '0038: quota.ai_facebook_suggestions.max exists with an unexpected shape; inspect plan_parameter_definition'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS engagement_suggestion_setting (
  setting_id      TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin          TEXT NOT NULL CHECK (origin IN ('facebook_comment')),
  version         INT  NOT NULL CHECK (version >= 1),
  mode            TEXT NOT NULL CHECK (mode IN ('off', 'on_demand', 'auto_suggest')),
  consent_text    TEXT,
  consent_version TEXT,
  consent_sha256  TEXT,
  decided_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, origin, version),
  CONSTRAINT engagement_suggestion_setting_consent CHECK (
    (consent_text IS NULL) = (consent_version IS NULL)
    AND (consent_version IS NULL) = (consent_sha256 IS NULL)
    AND (consent_version IS NULL OR consent_version ~ '^[a-z_]+(\.[a-z_]+)*\.v[0-9]+$')
    AND (consent_sha256 IS NULL OR consent_sha256 ~ '^[0-9a-f]{64}$')
    -- Solo las sugerencias automáticas gastan sin una petición explícita: solo ellas (y siempre) guardan consentimiento.
    AND ((mode = 'auto_suggest') = (consent_version IS NOT NULL)))
);

CREATE OR REPLACE FUNCTION engagement_suggestion_setting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'engagement_suggestion_setting is append-only: record a new version instead of updating %', OLD.setting_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.consent_sha256 IS NOT NULL
     AND NEW.consent_sha256 <> encode(sha256(convert_to(NEW.consent_text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'engagement_suggestion_setting.consent_sha256 does not match the stored consent text'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_engagement_suggestion_setting_guard BEFORE INSERT OR UPDATE ON engagement_suggestion_setting
  FOR EACH ROW EXECUTE FUNCTION engagement_suggestion_setting_guard();
