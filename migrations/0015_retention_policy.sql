-- MainSpot DEC-0021..DEC-0027 (QS-0006) — retención global, baja y anonimización.
-- Idempotent per migration run (IF NOT EXISTS + advisory lock in runner).

-- 1) DEC-0021: el contenido conversacional se conserva 90 días. La purga redacta el
--    contenido (mensaje, respuesta, propuesta derivada, cuerpos enviados a Jev) y deja
--    la estructura (intención, clase, estado, fechas) que usan auditoría y cuotas.
ALTER TABLE conversation_request ADD COLUMN IF NOT EXISTS content_purged_at TIMESTAMPTZ;
ALTER TABLE action_proposal ADD COLUMN IF NOT EXISTS content_purged_at TIMESTAMPTZ;
ALTER TABLE jev_classification ADD COLUMN IF NOT EXISTS content_purged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_conversation_request_content_due
  ON conversation_request(created_at) WHERE content_purged_at IS NULL;

-- Una clasificación evaluada exige sus cuerpos raw salvo que la retención los haya purgado.
ALTER TABLE jev_classification DROP CONSTRAINT IF EXISTS jev_classification_check;
ALTER TABLE jev_classification ADD CONSTRAINT jev_classification_check CHECK (
  (status = 'evaluated'
    AND jev_intent IS NOT NULL AND jev_intent_probability IS NOT NULL AND jev_intent_confidence IS NOT NULL
    AND jev_intent_probabilities IS NOT NULL AND jev_capability_target IS NOT NULL
    AND jev_capability_confidence IS NOT NULL AND jev_capability_probabilities IS NOT NULL
    AND (jev_action_class IS NULL) = (jev_intent = 'other') AND (agreement IS NULL) = (jev_intent = 'other')
    AND resolved_model IS NOT NULL AND usage IS NOT NULL AND cost_source IS NOT NULL
    AND ((raw_request IS NOT NULL AND raw_response IS NOT NULL) OR content_purged_at IS NOT NULL)
    AND error_code IS NULL)
  OR
  (status = 'unavailable'
    AND jev_intent IS NULL AND jev_intent_probability IS NULL AND jev_intent_confidence IS NULL
    AND jev_intent_probabilities IS NULL AND jev_action_class IS NULL AND jev_capability_target IS NULL
    AND jev_capability_confidence IS NULL AND jev_capability_probabilities IS NULL
    AND agreement IS NULL AND error_code IS NOT NULL)
);

-- 2) DEC-0025: informe de cada ejecución (automática diaria, manual o tras restaurar).
--    Solo totales: el detalle por tenant va en su evento de auditoría `retention.purged`.
CREATE TABLE IF NOT EXISTS retention_run (
  run_id       TEXT PRIMARY KEY,
  run_day      DATE NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('scheduled','manual','restore_reapply')),
  dry_run      BOOLEAN NOT NULL,
  policy       JSONB NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  totals       JSONB NOT NULL DEFAULT '{}',
  error_code   TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_retention_run_scheduled_day
  ON retention_run(run_day) WHERE trigger = 'scheduled' AND NOT dry_run AND status = 'completed';

-- 3) DEC-0024/DEC-0027: baja confirmada (con exportación previa) y anonimización a los 30 días.
ALTER TABLE client DROP CONSTRAINT IF EXISTS client_status_check;
ALTER TABLE client ADD CONSTRAINT client_status_check
  CHECK (status IN ('active','suspended','exiting','anonymized'));

CREATE TABLE IF NOT EXISTS tenant_exit (
  tenant_id        TEXT PRIMARY KEY REFERENCES client(client_id) ON DELETE RESTRICT,
  confirmed_at     TIMESTAMPTZ NOT NULL,
  confirmed_by     TEXT NOT NULL,
  export_sha256    TEXT NOT NULL CHECK (export_sha256 ~ '^[0-9a-f]{64}$'),
  anonymize_after  TIMESTAMPTZ NOT NULL,
  CHECK (anonymize_after >= confirmed_at + interval '30 days')
);

-- Huella (sha256 del id) de los tenants ya anonimizados, sin el id en claro. Sirve solo para
-- volver a anonimizarlos si se restaura un respaldo anterior (DEC-0027: sin reintroducción) y
-- se borra cuando ya no queda ningún respaldo que los contenga (DEC-0026: 14 días).
CREATE TABLE IF NOT EXISTS anonymized_tenant (
  tenant_sha256  TEXT PRIMARY KEY CHECK (tenant_sha256 ~ '^[0-9a-f]{64}$'),
  anonymized_at  TIMESTAMPTZ NOT NULL,
  run_id         TEXT NOT NULL
);

-- 4) DEC-0025: la purga manual desaparece; la administración solo ve la vista previa.
--    Espejo de src/rbac/matrix.ts (analytics.purge → analytics.retention).
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('analytics.retention', 'analytics.retention', '*', 'allow', 'Ver qué datos purgará la retención automática')
ON CONFLICT (permission_id) DO NOTHING;
INSERT INTO role_permission (role_id, permission_id) VALUES ('administration', 'analytics.retention')
ON CONFLICT (role_id, permission_id) DO NOTHING;
DELETE FROM role_permission WHERE permission_id = 'analytics.purge';
DELETE FROM permission WHERE permission_id = 'analytics.purge';
