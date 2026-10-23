-- MainSpot APR-0002 (MSP-JEV-CLASSIFIER-MODES v1) — Jev como clasificador semántico.
-- Sustituye a 0012_jev_shadow_evaluation.sql (nunca aplicada fuera de bases de prueba
-- temporales): la tabla de evidencia pasa a llamarse jev_classification y registra
-- también el modo, el origen de la decisión y la lectura completa de Jev.
-- Idempotent per migration run (IF NOT EXISTS + advisory lock in runner).
-- FKs con ON DELETE RESTRICT (nunca cascade de datos de tenant).
-- INVARIANT: jamás se guardan cabeceras ni la credencial (TYPESAFE_API_KEY). Los cuerpos
-- raw contienen el texto del mensaje (ya almacenado en conversation_request.raw_message,
-- mismo tenant) + las preguntas fijas; solo existen para tenants sintéticos (DEC-0019).

-- FK compuesta (request_id, tenant_id): la clasificación SIEMPRE pertenece al mismo
-- tenant que la solicitud clasificada (aislamiento por cliente a nivel de esquema).
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_request_request_tenant
  ON conversation_request(request_id, tenant_id);

CREATE TABLE IF NOT EXISTS jev_classification (
  classification_id          TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  request_id                 TEXT NOT NULL UNIQUE,
  policy_version             TEXT NOT NULL,                 -- preguntas + criterios + política
  mode                       TEXT NOT NULL CHECK (mode IN ('shadow','primary')),   -- modo efectivo
  decision_source            TEXT NOT NULL CHECK (decision_source IN ('deterministic','jev','deterministic_fallback','human_escalation')),
  decision_reason            TEXT NOT NULL CHECK (decision_reason IN ('shadow','primary_gated','jev_confident','low_confidence','other_intent','safety_discrepancy','jev_unavailable','model_not_evaluated')),
  deterministic_intent       TEXT NOT NULL,
  deterministic_action_class TEXT NOT NULL CHECK (deterministic_action_class IN ('read_only','draft','preview_required','human_approval_required','prohibited')),
  final_intent               TEXT NOT NULL,                 -- clasificación con la que se enrutó
  final_action_class         TEXT NOT NULL CHECK (final_action_class IN ('read_only','draft','preview_required','human_approval_required','prohibited')),
  status                     TEXT NOT NULL CHECK (status IN ('evaluated','unavailable')),
  jev_intent                 TEXT CHECK (jev_intent IN ('query.read_only','content.suggestion','request.needs_clarification','website.edit','change.ambiguous','sensitive.business_decision','rule.prohibited_commercial','capability.unsupported','other')),
  jev_intent_probability     DOUBLE PRECISION CHECK (jev_intent_probability BETWEEN 0 AND 1),
  jev_intent_confidence      DOUBLE PRECISION CHECK (jev_intent_confidence BETWEEN 0 AND 1),
  jev_intent_probabilities   JSONB,                         -- distribución completa por intent
  jev_action_class           TEXT CHECK (jev_action_class IN ('read_only','draft','preview_required','human_approval_required','prohibited')),
  jev_capability_target      TEXT CHECK (jev_capability_target IN ('website','social','reputation','domain','unknown')),
  jev_capability_confidence  DOUBLE PRECISION CHECK (jev_capability_confidence BETWEEN 0 AND 1),
  jev_capability_probabilities JSONB,
  agreement                  BOOLEAN,                       -- jev_action_class = deterministic_action_class
  provider                   TEXT NOT NULL CHECK (provider IN ('typesafe')),
  requested_model            TEXT NOT NULL,                 -- JEV_MODEL o alias del proveedor
  resolved_model             TEXT,                          -- modelo versionado reportado por la respuesta
  usage                      JSONB,                         -- usage del proveedor (tokens, cost si viene)
  cost_usd                   NUMERIC CHECK (cost_usd >= 0),
  cost_source                TEXT CHECK (cost_source IN ('reported','estimated','unknown','mock')),
  budget_day                 DATE NOT NULL,                 -- día UTC del libro de presupuesto (DEC-0032)
  latency_ms                 INT NOT NULL CHECK (latency_ms >= 0),
  error_code                 TEXT,                          -- código seguro (sin mensajes del proveedor)
  raw_request                TEXT,                          -- cuerpo JSON exacto enviado (sin cabeceras)
  raw_response               TEXT,                          -- cuerpo JSON exacto recibido
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, tenant_id) REFERENCES conversation_request(request_id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'evaluated'
      AND jev_intent IS NOT NULL AND jev_intent_probability IS NOT NULL AND jev_intent_confidence IS NOT NULL
      AND jev_intent_probabilities IS NOT NULL AND jev_capability_target IS NOT NULL
      AND jev_capability_confidence IS NOT NULL AND jev_capability_probabilities IS NOT NULL
      AND (jev_action_class IS NULL) = (jev_intent = 'other') AND (agreement IS NULL) = (jev_intent = 'other')
      AND resolved_model IS NOT NULL AND usage IS NOT NULL AND cost_source IS NOT NULL
      AND raw_request IS NOT NULL AND raw_response IS NOT NULL AND error_code IS NULL)
    OR
    (status = 'unavailable'
      AND jev_intent IS NULL AND jev_intent_probability IS NULL AND jev_intent_confidence IS NULL
      AND jev_intent_probabilities IS NULL AND jev_action_class IS NULL AND jev_capability_target IS NULL
      AND jev_capability_confidence IS NULL AND jev_capability_probabilities IS NULL
      AND agreement IS NULL AND error_code IS NOT NULL)
  ),
  -- Coherencia modo / origen / motivo (D1 DEC-0028, D2 DEC-0029, D3 DEC-0030, D4 DEC-0031).
  CHECK (
    (mode = 'shadow' AND decision_source = 'deterministic' AND decision_reason IN ('shadow','primary_gated'))
    OR (mode = 'primary' AND decision_source = 'jev' AND status = 'evaluated' AND decision_reason IN ('jev_confident','low_confidence','other_intent'))
    OR (mode = 'primary' AND decision_source = 'human_escalation' AND status = 'evaluated' AND decision_reason = 'safety_discrepancy')
    OR (mode = 'primary' AND decision_source = 'deterministic_fallback'
        AND ((status = 'unavailable' AND decision_reason = 'jev_unavailable')
          OR (status = 'evaluated' AND decision_reason = 'model_not_evaluated')))
  )
);
CREATE INDEX IF NOT EXISTS idx_jev_classification_tenant_ts ON jev_classification(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jev_classification_budget_day ON jev_classification(budget_day);

-- D4 (DEC-0031): evaluación del conjunto sintético. Plataforma, sin datos de tenant.
-- primary solo se abre si la ÚLTIMA ejecución para (policy_version, requested_model)
-- cumple los umbrales recalculados en código.
CREATE TABLE IF NOT EXISTS jev_evaluation_run (
  run_id               TEXT PRIMARY KEY,
  policy_version       TEXT NOT NULL,
  provider             TEXT NOT NULL CHECK (provider IN ('typesafe')),
  requested_model      TEXT NOT NULL,
  resolved_models      JSONB NOT NULL,                      -- modelos versionados observados
  dataset_version      TEXT NOT NULL,
  dataset_sha256       TEXT NOT NULL,
  cases_total          INT NOT NULL CHECK (cases_total >= 0),
  cases_evaluated      INT NOT NULL CHECK (cases_evaluated BETWEEN 0 AND cases_total),
  intent_correct       INT NOT NULL CHECK (intent_correct BETWEEN 0 AND cases_evaluated),
  risky_cases          INT NOT NULL CHECK (risky_cases BETWEEN 0 AND cases_total),
  risky_misses         INT NOT NULL CHECK (risky_misses BETWEEN 0 AND risky_cases),
  capability_correct   INT NOT NULL CHECK (capability_correct BETWEEN 0 AND cases_evaluated),
  min_probability      DOUBLE PRECISION NOT NULL CHECK (min_probability BETWEEN 0 AND 1),
  passed               BOOLEAN NOT NULL,
  cost_usd             NUMERIC NOT NULL CHECK (cost_usd >= 0),
  budget_day           DATE NOT NULL,
  report               JSONB NOT NULL,                      -- métricas por intent y resultado por caso
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jev_evaluation_run_gate ON jev_evaluation_run(policy_version, requested_model, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_jev_evaluation_run_budget_day ON jev_evaluation_run(budget_day);
