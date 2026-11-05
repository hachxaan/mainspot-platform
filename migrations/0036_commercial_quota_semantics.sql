-- MainSpot DEC-0076 (SRC-0014, decisiones comerciales del 2026-11-05) — registro de parámetros de plan v2.
-- Migración ADITIVA y transaccional (el runner ejecuta el archivo completo en una transacción):
--   1. quota.ai_review_replies.max: cuota PERIÓDICA de respuestas a reseñas redactadas con IA, por ciclo mensual
--      anclado a subscription.started_at (UTC), sin acumulación. Ninguna revisión publicada la define: hasta
--      publicar una revisión nueva con el valor confirmado, redactar con IA una respuesta a una reseña se deniega
--      (fail-closed). Recibir reseñas y responder manualmente no dependen de ella.
--   2. quota.reviews_managed.max: enforcement retirado (not_enforced). Recibir y sincronizar reseñas no consume
--      cuota; los valores de las revisiones publicadas se conservan (inmutables) y el recuento sigue visible.
--   3. registry_version = 2 en las definiciones del registro (espejo de PLAN_REGISTRY_VERSION).
--   4. engagement_case.ai_draft: la propuesta que la persona pide con «Redactar con IA» se guarda aparte de las tres
--      propuestas numeradas, para que su numeración (la del aviso de Telegram) no cambie después de avisar.
-- No toca revisiones, valores, suscripciones ni el libro de cuotas. Sin precios ni cobros.
-- Reversión (solo mientras ningún valor ni reserva use la capacidad nueva): scripts/commercial-quota-rollback.sql.
-- Re-ejecutable: aplicarla de nuevo sobre un esquema ya migrado no cambia nada.

INSERT INTO plan_parameter_definition
  (parameter_key, capability, category, label, description, unit, value_type, semantics, period_kind, window_seconds,
   min_value, max_value, ceiling_reason, suggested_int, suggested_bool, enforcement_state, registry_version, sort_order) VALUES
  ('quota.ai_review_replies.max', 'ai_review_replies', 'Reseñas', 'Respuestas a reseñas con IA',
   'Respuestas a reseñas de Google redactadas con IA en cada ciclo mensual de la suscripción (anclado a su inicio, UTC). Cada respuesta generada con IA consume 1 al generarse; recibir reseñas y responder manualmente no consumen. Lo no usado no se acumula. Agotarlas solo bloquea la redacción con IA.',
   'respuestas', 'int', 'periodic', 'subscription_month', NULL, 0, 1000000,
   'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).',
   0, NULL, 'enforced', 2, 45)
ON CONFLICT (parameter_key) DO NOTHING;

UPDATE plan_parameter_definition
   SET description = 'Reseñas recibidas por el negocio (solo informativo). Recibir y sincronizar reseñas no consume cuota ni se limita por plan (DEC-0076, SRC-0014 C01); el valor de las revisiones publicadas se conserva sin efecto.',
       enforcement_state = 'not_enforced'
 WHERE parameter_key = 'quota.reviews_managed.max';

UPDATE plan_parameter_definition SET registry_version = 2
 WHERE parameter_key IN ('quota.website.max', 'quota.social_posts.max', 'quota.social_ads.max', 'quota.reviews_managed.max',
                         'quota.ai_review_replies.max', 'quota.conversations.max', 'quota.agents.max');

-- Defensa: si la definición ya existía con otra forma (p. ej. creada a mano), abortar en vez de dejar un espejo
-- incoherente con el registro.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_parameter_definition
                  WHERE parameter_key = 'quota.ai_review_replies.max' AND capability = 'ai_review_replies'
                    AND value_type = 'int' AND semantics = 'periodic' AND period_kind = 'subscription_month'
                    AND min_value = 0 AND max_value = 1000000 AND suggested_int = 0 AND enforcement_state = 'enforced') THEN
    RAISE EXCEPTION '0036: quota.ai_review_replies.max exists with an unexpected shape; inspect plan_parameter_definition'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- Propuesta pedida con «Redactar con IA»: fuera del arreglo numerado `drafts` (no desplaza las opciones del aviso) y
-- solo junto con la invocación que la redactó. Columna nueva y nula: la restricción va NOT VALID para no recorrer la
-- tabla con el candado exclusivo (todas las filas existentes la cumplen por construcción; las nuevas se comprueban).
ALTER TABLE engagement_case ADD COLUMN IF NOT EXISTS ai_draft TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_case_ai_draft_check') THEN
    ALTER TABLE engagement_case ADD CONSTRAINT engagement_case_ai_draft_check
      CHECK (ai_draft IS NULL OR (length(ai_draft) BETWEEN 1 AND 4000 AND reply_invocation_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;
