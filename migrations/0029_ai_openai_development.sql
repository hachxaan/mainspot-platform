-- DEC-0073: configuración actual de desarrollo, no selección comercial irreversible.
-- Anthropic conserva adaptador/modelos/evidencia como alternativa técnica, fuera de operación.
-- No se activa ninguna ruta OpenAI: primero debe superar evaluación y aprobación existentes.
UPDATE ai_provider SET status = 'disabled', updated_at = now() WHERE kind = 'anthropic';

DO $$
DECLARE
  r RECORD;
  v BIGINT;
BEGIN
  FOR r IN
    SELECT ro.use_case_id, ro.environment, ro.version,
           CASE WHEN pa.kind = 'anthropic' THEN ro.active_route_id END AS active_retired,
           CASE WHEN pc.kind = 'anthropic' THEN ro.canary_route_id END AS canary_retired
      FROM ai_rollout ro
      LEFT JOIN ai_route_revision ra ON ra.route_id = ro.active_route_id
      LEFT JOIN ai_model ma ON ma.model_id = ra.model_id
      LEFT JOIN ai_provider pa ON pa.provider_id = ma.provider_id
      LEFT JOIN ai_route_revision rc ON rc.route_id = ro.canary_route_id
      LEFT JOIN ai_model mc ON mc.model_id = rc.model_id
      LEFT JOIN ai_provider pc ON pc.provider_id = mc.provider_id
     WHERE pa.kind = 'anthropic' OR pc.kind = 'anthropic'
  LOOP
    v := r.version + 1;
    UPDATE ai_rollout
       SET active_route_id = CASE WHEN r.active_retired IS NOT NULL THEN NULL ELSE active_route_id END,
           canary_route_id = CASE WHEN r.canary_retired IS NOT NULL THEN NULL ELSE canary_route_id END,
           canary_percent = CASE WHEN r.canary_retired IS NOT NULL THEN 0 ELSE canary_percent END,
           version = v, updated_by = 'system:migration-0029', updated_at = now()
     WHERE use_case_id = r.use_case_id AND environment = r.environment;
    IF r.active_retired IS NOT NULL THEN
      INSERT INTO ai_rollout_event (event_id, use_case_id, environment, action, from_route_id, to_route_id, rollout_version, actor_id, reason)
      VALUES ('rev_' || gen_random_uuid(), r.use_case_id, r.environment, 'retire', r.active_retired, NULL, v,
              'system:migration-0029', 'DEC-0073: generación de desarrollo exclusivamente OpenAI; Anthropic queda alternativa técnica sin tráfico');
    END IF;
    IF r.canary_retired IS NOT NULL THEN
      INSERT INTO ai_rollout_event (event_id, use_case_id, environment, action, from_route_id, to_route_id, canary_percent, rollout_version, actor_id, reason)
      VALUES ('rev_' || gen_random_uuid(), r.use_case_id, r.environment, 'retire', r.canary_retired, NULL, 0, v,
              'system:migration-0029', 'DEC-0073: retirar canary Anthropic sin fallback ni activación sustituta');
    END IF;
  END LOOP;
END $$;

UPDATE ai_route_revision SET status = 'RETIRED'
 WHERE status <> 'RETIRED'
   AND model_id IN (SELECT m.model_id FROM ai_model m JOIN ai_provider p ON p.provider_id = m.provider_id WHERE p.kind = 'anthropic');
-- OpenRouter sigue bajo el bloqueo existente de 0028. Costos, evaluaciones y trazas no se modifican.
