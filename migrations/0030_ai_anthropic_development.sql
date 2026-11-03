-- DEC-0074: configuración de desarrollo — Anthropic directo para texto/razonamiento, OpenAI directo solo imágenes,
-- TypeSafe (Jev) sin cambios. Es una preferencia de desarrollo, no una selección comercial irreversible.
--  - Anthropic vuelve a estar operativo como proveedor. Sus rutas retiradas por DEC-0073 (0029) siguen RETIRED
--    como historia: las candidatas nuevas las siembra el catálogo (src/ai/catalog.ts) en DRAFT y nada se activa aquí.
--  - Los modelos de TEXTO de OpenAI se deshabilitan; sus rutas salen de todo rollout (evento `retire`, sin
--    sustituta ni fallback) y quedan RETIRED. gpt-image-2 y sus rutas no se tocan.
--  - Invocaciones, evaluaciones, costos y trazas no se modifican.
UPDATE ai_provider SET status = 'active', updated_at = now() WHERE kind = 'anthropic';

UPDATE ai_model SET status = 'disabled'
 WHERE status <> 'disabled' AND modality = 'text'
   AND provider_id IN (SELECT provider_id FROM ai_provider WHERE kind = 'openai');

DO $$
DECLARE
  r RECORD;
  v BIGINT;
BEGIN
  FOR r IN
    SELECT ro.use_case_id, ro.environment, ro.version,
           CASE WHEN pa.kind = 'openai' AND ma.modality = 'text' THEN ro.active_route_id END AS active_retired,
           CASE WHEN pc.kind = 'openai' AND mc.modality = 'text' THEN ro.canary_route_id END AS canary_retired
      FROM ai_rollout ro
      LEFT JOIN ai_route_revision ra ON ra.route_id = ro.active_route_id
      LEFT JOIN ai_model ma ON ma.model_id = ra.model_id
      LEFT JOIN ai_provider pa ON pa.provider_id = ma.provider_id
      LEFT JOIN ai_route_revision rc ON rc.route_id = ro.canary_route_id
      LEFT JOIN ai_model mc ON mc.model_id = rc.model_id
      LEFT JOIN ai_provider pc ON pc.provider_id = mc.provider_id
     WHERE (pa.kind = 'openai' AND ma.modality = 'text') OR (pc.kind = 'openai' AND mc.modality = 'text')
  LOOP
    v := r.version + 1;
    UPDATE ai_rollout
       SET active_route_id = CASE WHEN r.active_retired IS NOT NULL THEN NULL ELSE active_route_id END,
           canary_route_id = CASE WHEN r.canary_retired IS NOT NULL THEN NULL ELSE canary_route_id END,
           canary_percent = CASE WHEN r.canary_retired IS NOT NULL THEN 0 ELSE canary_percent END,
           version = v, updated_by = 'system:migration-0030', updated_at = now()
     WHERE use_case_id = r.use_case_id AND environment = r.environment;
    IF r.active_retired IS NOT NULL THEN
      INSERT INTO ai_rollout_event (event_id, use_case_id, environment, action, from_route_id, to_route_id, rollout_version, actor_id, reason)
      VALUES ('rev_' || gen_random_uuid(), r.use_case_id, r.environment, 'retire', r.active_retired, NULL, v,
              'system:migration-0030', 'DEC-0074: texto de desarrollo con Anthropic directo; el texto de OpenAI sale de operación sin sustituta automática ni fallback');
    END IF;
    IF r.canary_retired IS NOT NULL THEN
      INSERT INTO ai_rollout_event (event_id, use_case_id, environment, action, from_route_id, to_route_id, canary_percent, rollout_version, actor_id, reason)
      VALUES ('rev_' || gen_random_uuid(), r.use_case_id, r.environment, 'retire', r.canary_retired, NULL, 0, v,
              'system:migration-0030', 'DEC-0074: retirar canary de texto OpenAI sin fallback ni activación sustituta');
    END IF;
  END LOOP;
END $$;

UPDATE ai_route_revision SET status = 'RETIRED'
 WHERE status <> 'RETIRED'
   AND model_id IN (SELECT m.model_id FROM ai_model m JOIN ai_provider p ON p.provider_id = m.provider_id
                     WHERE p.kind = 'openai' AND m.modality = 'text');
-- OpenRouter sigue bajo el bloqueo de 0028; las rutas Anthropic retiradas por 0029 no se reviven.
