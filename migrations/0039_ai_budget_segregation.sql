-- FB-3 (DEC-0078; SRC-007 «Adelante», RES-MSP-20261106-FB-AI-01): el gasto experimental del laboratorio se separa del
-- presupuesto comercial operativo y los dos siguen bajo el techo global estricto `lab_total`; el gasto de IA se
-- atribuye por canal.
--
-- Sin valores nuevos: esta migración NO crea ninguna fila de presupuesto. Sin fila `lab_experiment`, toda invocación
-- de pago bajo grant de laboratorio se deniega (`budget_exhausted`, detalle `lab_experiment`) hasta que un
-- platform_admin la configure con step-up, motivo y auditoría (PUT /api/platform/ai/budgets/lab_experiment).
-- Las filas existentes conservan su significado; `tenant_day` pasa a contar solo el gasto operativo (sin grant).
--
-- Bloqueo: ai_budget y ai_use_case tienen pocas filas y el archivo es una sola transacción; las restricciones se
-- añaden validadas (NOT VALID no acortaría el ACCESS EXCLUSIVE que el ALTER TABLE ya toma hasta el COMMIT).

-- ---------------------------------------------------------------- ámbito lab_experiment: una sola fila global
ALTER TABLE ai_budget DROP CONSTRAINT IF EXISTS ai_budget_scope_check;
ALTER TABLE ai_budget ADD CONSTRAINT ai_budget_scope_check
  CHECK (scope IN ('lab_total','platform_month','tenant_day','lab_experiment'));
-- Con uq_ai_budget_scope (scope, COALESCE(tenant_id,'-')) queda como mucho una fila, siempre sin negocio.
ALTER TABLE ai_budget DROP CONSTRAINT IF EXISTS ai_budget_lab_experiment_global_check;
ALTER TABLE ai_budget ADD CONSTRAINT ai_budget_lab_experiment_global_check
  CHECK (scope <> 'lab_experiment' OR tenant_id IS NULL);

-- ---------------------------------------------------------------- canal de atribución por caso de uso
-- Un canal por caso de uso, el mismo mapa que USE_CASE_SEEDS (src/ai/catalog.ts) y AI_CHANNELS (src/ai/registry.ts).
-- Solo atribuye: ningún canal tiene límite ni partición propia (el propietario los calibrará con datos reales).
ALTER TABLE ai_use_case ADD COLUMN IF NOT EXISTS channel TEXT;
UPDATE ai_use_case SET channel = CASE use_case_id
    WHEN 'conversation.intent.classify'         THEN 'owner_intent'
    WHEN 'conversation.owner.assistant'         THEN 'assistant'
    WHEN 'website.initial.design'               THEN 'website'
    WHEN 'website.edit.simple'                  THEN 'website'
    WHEN 'website.edit.complex'                 THEN 'website'
    WHEN 'website.image.generate'               THEN 'website'
    WHEN 'social.facebook.post.compose'         THEN 'facebook_posts'
    WHEN 'social.facebook.image.generate'       THEN 'facebook_posts'
    WHEN 'engagement.facebook.comment.classify' THEN 'facebook_comments'
    WHEN 'engagement.facebook.comment.reply'    THEN 'facebook_comments'
    WHEN 'engagement.google.review.classify'    THEN 'google_reviews'
    WHEN 'engagement.google.review.reply'       THEN 'google_reviews'
    WHEN 'marketing.campaign.plan'              THEN 'campaigns'
    WHEN 'marketing.campaign.creatives'         THEN 'campaigns'
    WHEN 'business.insights.generate'           THEN 'insights'
    WHEN 'editorial.calendar.suggest'           THEN 'editorial'
  END
 WHERE channel IS NULL;
-- Un caso de uso fuera del mapa no recibe un canal por omisión: la migración entera se deshace con el motivo.
DO $$
DECLARE
  unknown TEXT;
BEGIN
  SELECT string_agg(use_case_id, ', ' ORDER BY use_case_id) INTO unknown FROM ai_use_case WHERE channel IS NULL;
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION '0039: casos de uso sin canal de atribución conocido: %. Añádelos al mapa de esta migración y a src/ai/catalog.ts antes de aplicarla', unknown
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
ALTER TABLE ai_use_case ALTER COLUMN channel SET NOT NULL;
ALTER TABLE ai_use_case DROP CONSTRAINT IF EXISTS ai_use_case_channel_check;
ALTER TABLE ai_use_case ADD CONSTRAINT ai_use_case_channel_check
  CHECK (channel IN ('owner_intent','assistant','website','facebook_posts','facebook_comments','google_reviews','campaigns','insights','editorial'));
