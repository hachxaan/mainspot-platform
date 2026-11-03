-- AI Core × proveedores directos (DEC-0069) y datos reales por proveedor verificado (DEC-0067, DEC-0071).
--  - Nuevos tipos de proveedor: anthropic (texto) y openai (imágenes; texto solo si se evalúa).
--  - `real_data`: un negocio clasificado `real` solo puede usar un proveedor con cobertura contractual
--    verificada (fecha + base documental). Por defecto, bloqueado.
--  - OpenRouter queda deshabilitado de forma permanente: sus rutas salen de todo rollout (evento
--    `retire`), se retiran, y su historial (invocaciones, evaluaciones, costos) se conserva intacto.

ALTER TABLE ai_provider DROP CONSTRAINT IF EXISTS ai_provider_kind_check;
ALTER TABLE ai_provider ADD CONSTRAINT ai_provider_kind_check
  CHECK (kind IN ('anthropic','openai','typesafe','simulated','openrouter'));

ALTER TABLE ai_provider ADD COLUMN IF NOT EXISTS real_data TEXT NOT NULL DEFAULT 'blocked';
ALTER TABLE ai_provider ADD COLUMN IF NOT EXISTS real_data_basis TEXT;
ALTER TABLE ai_provider ADD COLUMN IF NOT EXISTS terms_verified_at TIMESTAMPTZ;
ALTER TABLE ai_provider DROP CONSTRAINT IF EXISTS ai_provider_real_data_check;
ALTER TABLE ai_provider ADD CONSTRAINT ai_provider_real_data_check
  CHECK (real_data IN ('blocked','allowed') AND (real_data = 'blocked' OR (real_data_basis IS NOT NULL AND terms_verified_at IS NOT NULL)));

ALTER TABLE ai_rollout_event DROP CONSTRAINT IF EXISTS ai_rollout_event_action_check;
ALTER TABLE ai_rollout_event ADD CONSTRAINT ai_rollout_event_action_check
  CHECK (action IN ('activate','canary','promote','rollback','clear_canary','seed','retire'));

-- ---------------------------------------------------------------- retiro de OpenRouter (DEC-0069)
UPDATE ai_provider
   SET status = 'disabled', real_data = 'blocked', real_data_basis = NULL, terms_verified_at = NULL,
       data_policy = 'Retirado (DEC-0069): sin nuevas ejecuciones, ni como intermediario ni como respaldo. Se conserva solo como historial de invocaciones, evaluaciones y costos.',
       updated_at = now()
 WHERE kind = 'openrouter';
UPDATE ai_model SET status = 'disabled'
 WHERE provider_id IN (SELECT provider_id FROM ai_provider WHERE kind = 'openrouter');

DO $$
DECLARE
  r RECORD;
  v BIGINT;
BEGIN
  FOR r IN
    SELECT ro.use_case_id, ro.environment, ro.version,
           CASE WHEN pa.kind = 'openrouter' THEN ro.active_route_id END AS active_retired,
           CASE WHEN pc.kind = 'openrouter' THEN ro.canary_route_id END AS canary_retired
      FROM ai_rollout ro
      LEFT JOIN ai_route_revision ra ON ra.route_id = ro.active_route_id
      LEFT JOIN ai_model ma ON ma.model_id = ra.model_id
      LEFT JOIN ai_provider pa ON pa.provider_id = ma.provider_id
      LEFT JOIN ai_route_revision rc ON rc.route_id = ro.canary_route_id
      LEFT JOIN ai_model mc ON mc.model_id = rc.model_id
      LEFT JOIN ai_provider pc ON pc.provider_id = mc.provider_id
     WHERE pa.kind = 'openrouter' OR pc.kind = 'openrouter'
  LOOP
    v := r.version + 1;
    UPDATE ai_rollout
       SET active_route_id = CASE WHEN r.active_retired IS NOT NULL THEN NULL ELSE active_route_id END,
           canary_route_id = CASE WHEN r.canary_retired IS NOT NULL THEN NULL ELSE canary_route_id END,
           canary_percent  = CASE WHEN r.canary_retired IS NOT NULL THEN 0 ELSE canary_percent END,
           version = v, updated_by = 'system:migration-0028', updated_at = now()
     WHERE use_case_id = r.use_case_id AND environment = r.environment;
    IF r.active_retired IS NOT NULL THEN
      INSERT INTO ai_rollout_event (event_id, use_case_id, environment, action, from_route_id, to_route_id, canary_percent, rollout_version, actor_id, reason)
      VALUES ('rev_' || gen_random_uuid(), r.use_case_id, r.environment, 'retire', r.active_retired, NULL, NULL, v, 'system:migration-0028',
              'DEC-0069: OpenRouter fuera de las rutas operativas; el caso de uso espera una ruta directa evaluada');
    END IF;
    IF r.canary_retired IS NOT NULL THEN
      INSERT INTO ai_rollout_event (event_id, use_case_id, environment, action, from_route_id, to_route_id, canary_percent, rollout_version, actor_id, reason)
      VALUES ('rev_' || gen_random_uuid(), r.use_case_id, r.environment, 'retire', r.canary_retired, NULL, 0, v, 'system:migration-0028',
              'DEC-0069: OpenRouter fuera de las rutas operativas (canary)');
    END IF;
  END LOOP;
END $$;

UPDATE ai_route_revision SET status = 'RETIRED'
 WHERE status <> 'RETIRED'
   AND model_id IN (SELECT m.model_id FROM ai_model m JOIN ai_provider p ON p.provider_id = m.provider_id WHERE p.kind = 'openrouter');

-- Un proveedor retirado no puede reactivarse ni recibir datos.
ALTER TABLE ai_provider DROP CONSTRAINT IF EXISTS ai_provider_openrouter_retired;
ALTER TABLE ai_provider ADD CONSTRAINT ai_provider_openrouter_retired CHECK (kind <> 'openrouter' OR status = 'disabled');

-- DEC-0068: el techo del laboratorio es acumulado e incluye el historial (la semilla nueva ya lo dice).
UPDATE ai_budget SET source = 'DEC-0068: USD 25 acumulado de IA generativa, incluido el consumo histórico', updated_at = now()
 WHERE budget_id = 'bud_lab_total';
