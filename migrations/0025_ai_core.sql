-- MainSpot AI Core (issue #9, canon FR-0012..FR-0019, DAT-0001). Migración aditiva: ninguna columna
-- existente cambia de significado. Las revisiones de prompt/ruta y los historiales son inmutables.

-- ---------------------------------------------------------------- inmutabilidad
CREATE OR REPLACE FUNCTION ai_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------- clasificación de datos por negocio (BR-0007)
-- real (por defecto): ningún dato sale a proveedores de IA hasta una decisión de privacidad (QS-0016).
-- synthetic: negocio de laboratorio con datos ficticios; lo marca solo platform_admin con motivo.
ALTER TABLE client ADD COLUMN IF NOT EXISTS data_classification TEXT NOT NULL DEFAULT 'real'
  CHECK (data_classification IN ('synthetic','real'));

-- ---------------------------------------------------------------- identidad de plataforma (FR-0018)
CREATE TABLE IF NOT EXISTS platform_user (
  platform_user_id TEXT PRIMARY KEY,
  login            TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  password_hash    TEXT NOT NULL,              -- pgcrypto bcrypt; nunca se emite
  totp_box         BYTEA NOT NULL,             -- secreto TOTP cifrado (SecretBox, AAD propia)
  totp_last_step   BIGINT NOT NULL DEFAULT 0,  -- anti-replay del código TOTP
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_user_role (
  platform_user_id TEXT NOT NULL REFERENCES platform_user(platform_user_id) ON DELETE RESTRICT,
  role             TEXT NOT NULL CHECK (role IN ('platform_admin','ai_engineer','platform_support')),
  granted_by       TEXT NOT NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_user_id, role)
);
CREATE TABLE IF NOT EXISTS platform_session (
  session_id       TEXT PRIMARY KEY,
  platform_user_id TEXT NOT NULL REFERENCES platform_user(platform_user_id) ON DELETE RESTRICT,
  roles            TEXT[] NOT NULL,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  mfa_at           TIMESTAMPTZ NOT NULL,
  step_up_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS platform_audit_event (
  event_id    TEXT PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    TEXT NOT NULL,
  actor_roles TEXT[] NOT NULL DEFAULT '{}',
  action      TEXT NOT NULL,
  resource    TEXT,
  tenant_id   TEXT,
  decision    TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  result      TEXT,
  reason      TEXT,
  request_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_at ON platform_audit_event(at DESC);
DROP TRIGGER IF EXISTS trg_platform_audit_immutable ON platform_audit_event;
CREATE TRIGGER trg_platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_audit_event
  FOR EACH ROW EXECUTE FUNCTION ai_forbid_mutation();

-- Acceso de soporte con motivo y caducidad; visible para el negocio (audit_event del tenant).
CREATE TABLE IF NOT EXISTS platform_support_access (
  access_id        TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  platform_user_id TEXT NOT NULL REFERENCES platform_user(platform_user_id) ON DELETE RESTRICT,
  reason           TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ
);

-- ---------------------------------------------------------------- registro de IA (FR-0012, FR-0019)
CREATE TABLE IF NOT EXISTS ai_use_case (
  use_case_id   TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  modality      TEXT NOT NULL CHECK (modality IN ('text','image','classification')),
  risk_level    TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  owner         TEXT NOT NULL,
  output_schema TEXT NOT NULL,
  tools         JSONB NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_provider (
  provider_id  TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('openrouter','typesafe','simulated')),
  base_url     TEXT,
  secret_ref   TEXT,                -- NOMBRE de la variable/secreto; nunca el valor
  data_policy  TEXT NOT NULL,
  terms_url    TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_model (
  model_id          TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES ai_provider(provider_id) ON DELETE RESTRICT,
  provider_model    TEXT NOT NULL,    -- ID exacto del proveedor (sin alias en producción)
  display_name      TEXT NOT NULL,
  modality          TEXT NOT NULL CHECK (modality IN ('text','image','classification')),
  capabilities      JSONB NOT NULL DEFAULT '{}',
  pricing           JSONB NOT NULL DEFAULT '{}',
  price_source      TEXT NOT NULL,
  price_observed_at TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_model)
);
CREATE TABLE IF NOT EXISTS ai_prompt_revision (
  revision_id   TEXT PRIMARY KEY,
  use_case_id   TEXT NOT NULL REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  version       INT NOT NULL CHECK (version > 0),
  system_text   TEXT NOT NULL,
  task_template TEXT NOT NULL,
  variables     JSONB NOT NULL DEFAULT '[]',
  sha256        TEXT NOT NULL,
  change_note   TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at    TIMESTAMPTZ,
  UNIQUE (use_case_id, version)
);
CREATE OR REPLACE FUNCTION ai_prompt_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'prompt revisions are immutable' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.system_text IS DISTINCT FROM OLD.system_text OR NEW.task_template IS DISTINCT FROM OLD.task_template
     OR NEW.variables IS DISTINCT FROM OLD.variables OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.use_case_id IS DISTINCT FROM OLD.use_case_id THEN
    RAISE EXCEPTION 'prompt revision content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_prompt_revision_immutable ON ai_prompt_revision;
CREATE TRIGGER trg_prompt_revision_immutable BEFORE UPDATE OR DELETE ON ai_prompt_revision
  FOR EACH ROW EXECUTE FUNCTION ai_prompt_revision_immutable();

CREATE TABLE IF NOT EXISTS ai_route_revision (
  route_id           TEXT PRIMARY KEY,
  use_case_id        TEXT NOT NULL REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  version            INT NOT NULL CHECK (version > 0),
  model_id           TEXT NOT NULL REFERENCES ai_model(model_id) ON DELETE RESTRICT,
  prompt_revision_id TEXT NOT NULL REFERENCES ai_prompt_revision(revision_id) ON DELETE RESTRICT,
  params             JSONB NOT NULL DEFAULT '{}',
  max_cost_usd       NUMERIC(10,4) NOT NULL CHECK (max_cost_usd > 0),
  sha256             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','TESTED','APPROVED','CANARY','ACTIVE','RETIRED')),
  change_note        TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  tested_eval_run_id TEXT,
  approved_by        TEXT,
  approved_at        TIMESTAMPTZ,
  UNIQUE (use_case_id, version)
);
CREATE OR REPLACE FUNCTION ai_route_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'route revisions are immutable' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.model_id IS DISTINCT FROM OLD.model_id OR NEW.prompt_revision_id IS DISTINCT FROM OLD.prompt_revision_id
     OR NEW.params IS DISTINCT FROM OLD.params OR NEW.max_cost_usd IS DISTINCT FROM OLD.max_cost_usd
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.use_case_id IS DISTINCT FROM OLD.use_case_id THEN
    RAISE EXCEPTION 'route revision content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_route_revision_immutable ON ai_route_revision;
CREATE TRIGGER trg_route_revision_immutable BEFORE UPDATE OR DELETE ON ai_route_revision
  FOR EACH ROW EXECUTE FUNCTION ai_route_revision_immutable();

CREATE TABLE IF NOT EXISTS ai_rollout (
  use_case_id     TEXT NOT NULL REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  environment     TEXT NOT NULL DEFAULT 'lab',
  active_route_id TEXT REFERENCES ai_route_revision(route_id) ON DELETE RESTRICT,
  canary_route_id TEXT REFERENCES ai_route_revision(route_id) ON DELETE RESTRICT,
  canary_percent  INT NOT NULL DEFAULT 0 CHECK (canary_percent BETWEEN 0 AND 100),
  version         BIGINT NOT NULL DEFAULT 1,
  updated_by      TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (use_case_id, environment),
  CHECK (canary_route_id IS NULL OR canary_route_id IS DISTINCT FROM active_route_id)
);
CREATE TABLE IF NOT EXISTS ai_rollout_event (
  event_id        TEXT PRIMARY KEY,
  use_case_id     TEXT NOT NULL,
  environment     TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('activate','canary','promote','rollback','clear_canary','seed')),
  from_route_id   TEXT,
  to_route_id     TEXT,
  canary_percent  INT,
  rollout_version BIGINT NOT NULL,
  actor_id        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rollout_event_uc ON ai_rollout_event(use_case_id, environment, at DESC);
DROP TRIGGER IF EXISTS trg_rollout_event_immutable ON ai_rollout_event;
CREATE TRIGGER trg_rollout_event_immutable BEFORE UPDATE OR DELETE ON ai_rollout_event
  FOR EACH ROW EXECUTE FUNCTION ai_forbid_mutation();

CREATE TABLE IF NOT EXISTS ai_eval_suite (
  suite_id    TEXT PRIMARY KEY,
  use_case_id TEXT NOT NULL REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  version     INT NOT NULL,
  cases       JSONB NOT NULL,
  thresholds  JSONB NOT NULL,
  sha256      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (use_case_id, name, version)
);
CREATE TABLE IF NOT EXISTS ai_eval_run (
  run_id        TEXT PRIMARY KEY,
  suite_id      TEXT NOT NULL REFERENCES ai_eval_suite(suite_id) ON DELETE RESTRICT,
  route_id      TEXT NOT NULL REFERENCES ai_route_revision(route_id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','error')),
  real_provider BOOLEAN NOT NULL,
  metrics       JSONB NOT NULL DEFAULT '{}',
  results       JSONB NOT NULL DEFAULT '[]',
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  started_by    TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_eval_run_route ON ai_eval_run(route_id, started_at DESC);

-- Traza y ledger de uso (NFR-0006). Sin texto completo de entrada: hash y salida minimizada.
CREATE TABLE IF NOT EXISTS ai_invocation (
  invocation_id      TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  tenant_id          TEXT REFERENCES client(client_id) ON DELETE RESTRICT,
  actor_id           TEXT NOT NULL,
  actor_kind         TEXT NOT NULL CHECK (actor_kind IN ('tenant_user','platform_user','system')),
  origin             TEXT NOT NULL,
  use_case_id        TEXT NOT NULL REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  route_id           TEXT REFERENCES ai_route_revision(route_id) ON DELETE RESTRICT,
  route_version      INT,
  prompt_revision_id TEXT,
  prompt_sha256      TEXT,
  model_id           TEXT,
  provider_id        TEXT,
  provider_model     TEXT,
  assignment         TEXT CHECK (assignment IN ('active','canary','pinned','eval')),
  policy_version     TEXT NOT NULL,
  consent_ref        TEXT,
  brand_version      INT,
  job_id             TEXT,
  eval_run_id        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','blocked')),
  reserved_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12,6),
  cost_source        TEXT NOT NULL DEFAULT 'none' CHECK (cost_source IN ('reported','estimated','unknown','none')),
  usage              JSONB NOT NULL DEFAULT '{}',
  latency_ms         INT,
  input_sha256       TEXT,
  output             JSONB,
  validation         JSONB NOT NULL DEFAULT '{}',
  error_code         TEXT,
  trace_id           TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_invocation_idem ON ai_invocation (COALESCE(tenant_id, '-'), use_case_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_ai_invocation_tenant ON ai_invocation(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_invocation_uc ON ai_invocation(use_case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_invocation_running ON ai_invocation(status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS ai_budget (
  budget_id  TEXT PRIMARY KEY,
  scope      TEXT NOT NULL CHECK (scope IN ('lab_total','platform_month','tenant_day')),
  tenant_id  TEXT REFERENCES client(client_id) ON DELETE RESTRICT,
  limit_usd  NUMERIC(12,4) NOT NULL CHECK (limit_usd >= 0),
  source     TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_budget_scope ON ai_budget (scope, COALESCE(tenant_id, '-'));

-- Trabajos durables (diseño web, imágenes, composición social).
CREATE TABLE IF NOT EXISTS ai_job (
  job_id          TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  idempotency_key TEXT NOT NULL,
  input           JSONB NOT NULL,
  pinned          JSONB NOT NULL DEFAULT '{}',
  progress        JSONB NOT NULL DEFAULT '{}',
  result          JSONB,
  error_code      TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  claim_token     TEXT,
  lease_until     TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  UNIQUE (tenant_id, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_job_due ON ai_job(status, next_attempt_at);

-- ---------------------------------------------------------------- Brand Studio (FR-0013)
CREATE TABLE IF NOT EXISTS brand_profile (
  tenant_id     TEXT PRIMARY KEY REFERENCES client(client_id) ON DELETE RESTRICT,
  brand_version INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brand_fact (
  fact_id       TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  fact_key      TEXT NOT NULL,
  value         JSONB NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('owner','import','ai_suggested','system')),
  status        TEXT NOT NULL CHECK (status IN ('confirmed','unconfirmed','rejected')),
  confidence    NUMERIC(3,2),
  valid_from    DATE,
  valid_until   DATE,
  brand_version INT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brand_fact_current ON brand_fact(tenant_id, fact_key, brand_version DESC);
DROP TRIGGER IF EXISTS trg_brand_fact_immutable ON brand_fact;
CREATE TRIGGER trg_brand_fact_immutable BEFORE UPDATE ON brand_fact
  FOR EACH ROW EXECUTE FUNCTION ai_forbid_mutation();

-- ---------------------------------------------------------------- biblioteca multimedia (FR-0013)
CREATE TABLE IF NOT EXISTS media_asset (
  asset_id        TEXT PRIMARY KEY,           -- aleatorio de 128 bits (capability URL)
  tenant_id       TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image')),
  source          TEXT NOT NULL CHECK (source IN ('ai_generated','uploaded')),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','archived')),
  purpose         TEXT NOT NULL,              -- website.hero, social.post, …
  mime            TEXT NOT NULL,
  width           INT NOT NULL,
  height          INT NOT NULL,
  bytes           BYTEA NOT NULL,
  sha256          TEXT NOT NULL,
  alt_text        TEXT NOT NULL,
  license         TEXT NOT NULL,
  is_illustration BOOLEAN NOT NULL,
  generator_model TEXT,
  invocation_id   TEXT,
  prompt_summary  TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_asset_tenant ON media_asset(tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS media_variant (
  asset_id  TEXT NOT NULL REFERENCES media_asset(asset_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  variant   TEXT NOT NULL,                    -- w640, w1280, w1920, sq1080, p1080x1350
  mime      TEXT NOT NULL,
  width     INT NOT NULL,
  height    INT NOT NULL,
  bytes     BYTEA NOT NULL,
  PRIMARY KEY (asset_id, variant)
);

-- ---------------------------------------------------------------- ledger único de respuestas públicas (FR-0016)
CREATE TABLE IF NOT EXISTS response_ledger (
  tenant_id    TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin       TEXT NOT NULL CHECK (origin IN ('google_review','facebook_comment')),
  target_ref   TEXT NOT NULL,
  path         TEXT NOT NULL CHECK (path IN ('engagement','reputation')),
  owner_ref    TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','sent','failed','uncertain')),
  external_ref TEXT,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, origin, target_ref)
);

-- ---------------------------------------------------------------- campañas, insights y calendario (FR-0015, FR-0017)
CREATE TABLE IF NOT EXISTS marketing_campaign (
  campaign_id         TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','plan_approved','rejected','archived')),
  objective           TEXT NOT NULL,
  brief               JSONB NOT NULL,
  plan                JSONB NOT NULL,
  budget_proposed_usd NUMERIC(12,2),
  budget_cap_usd      NUMERIC(12,2),
  -- Sin cuenta publicitaria autorizada el gasto nunca se autoriza (G3).
  spend_authorized    BOOLEAN NOT NULL DEFAULT false CHECK (spend_authorized = false),
  invocation_id       TEXT,
  brand_version       INT,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by          TEXT,
  decided_at          TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ai_insight (
  insight_id    TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('generated','abstained','failed')),
  summary       TEXT NOT NULL,
  recommendations JSONB NOT NULL DEFAULT '[]',
  evidence      JSONB NOT NULL DEFAULT '{}',
  invocation_id TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS editorial_suggestion (
  suggestion_id TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  suggested_for DATE NOT NULL,
  idea          TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','rejected','used')),
  post_id       TEXT REFERENCES social_post(post_id) ON DELETE RESTRICT,
  brand_version INT,
  invocation_id TEXT,
  feedback      TEXT,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- columnas nuevas en tablas existentes
ALTER TABLE social_post ADD COLUMN IF NOT EXISTS media_asset_id TEXT REFERENCES media_asset(asset_id) ON DELETE RESTRICT;
ALTER TABLE social_post ADD COLUMN IF NOT EXISTS generation JSONB;      -- variantes, invocaciones, brand_version
ALTER TABLE social_post ADD COLUMN IF NOT EXISTS brand_version INT;
ALTER TABLE engagement_case ADD COLUMN IF NOT EXISTS semantic JSONB;    -- lectura Jev (sin texto)
ALTER TABLE engagement_case ADD COLUMN IF NOT EXISTS sentiment TEXT CHECK (sentiment IN ('positive','neutral','negative','mixed'));
ALTER TABLE engagement_case ADD COLUMN IF NOT EXISTS semantic_source TEXT CHECK (semantic_source IN ('jev','blocked_external','unavailable'));
ALTER TABLE engagement_case ADD COLUMN IF NOT EXISTS reply_invocation_id TEXT;
