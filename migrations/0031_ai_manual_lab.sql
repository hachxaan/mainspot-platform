-- Laboratorio manual del AI Core (DEC-0074, SRC-0012): autorizaciones temporales acotadas a un negocio y un
-- usuario para ejecutar rutas en borrador (DRAFT) SOLO en el entorno de laboratorio, evidencia manual
-- real por invocación y revisión manual trazable que marca DRAFT → TESTED (distinta de la suite automática).
-- Migración aditiva: ninguna columna existente cambia de significado; el historial de invocaciones,
-- evaluaciones y costos se conserva intacto.

-- ---------------------------------------------------------------- autorización temporal (grant)
CREATE TABLE IF NOT EXISTS ai_lab_grant (
  grant_id      TEXT PRIMARY KEY,
  environment   TEXT NOT NULL,
  tenant_id     TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  user_id       TEXT NOT NULL REFERENCES internal_user(user_id) ON DELETE RESTRICT,
  issued_by     TEXT NOT NULL REFERENCES platform_user(platform_user_id) ON DELETE RESTRICT,
  issued_roles  TEXT[] NOT NULL DEFAULT '{}',
  reason        TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
  revoke_reason TEXT,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_ai_lab_grant_user ON ai_lab_grant(tenant_id, user_id, expires_at DESC);

-- Solo la revocación puede cambiar, una sola vez; el resto del grant es inmutable.
CREATE OR REPLACE FUNCTION ai_lab_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grant_id IS DISTINCT FROM OLD.grant_id OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by OR NEW.issued_roles IS DISTINCT FROM OLD.issued_roles
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'ai_lab_grant is immutable except for revocation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'ai_lab_grant revocation is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ai_lab_grant_guard ON ai_lab_grant;
CREATE TRIGGER trg_ai_lab_grant_guard BEFORE UPDATE ON ai_lab_grant
  FOR EACH ROW EXECUTE FUNCTION ai_lab_grant_guard();

-- Allowlist inmutable caso de uso → ruta (una ruta por caso de uso y grant). tenant_id denormalizado
-- para la salida de datos del negocio (retención). DELETE permitido solo por esa salida.
CREATE TABLE IF NOT EXISTS ai_lab_grant_route (
  grant_id    TEXT NOT NULL REFERENCES ai_lab_grant(grant_id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  use_case_id TEXT NOT NULL REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  route_id    TEXT NOT NULL REFERENCES ai_route_revision(route_id) ON DELETE RESTRICT,
  PRIMARY KEY (grant_id, use_case_id)
);
CREATE OR REPLACE FUNCTION ai_lab_grant_route_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_lab_grant_route allowlist is immutable' USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS trg_ai_lab_grant_route_immutable ON ai_lab_grant_route;
CREATE TRIGGER trg_ai_lab_grant_route_immutable BEFORE UPDATE ON ai_lab_grant_route
  FOR EACH ROW EXECUTE FUNCTION ai_lab_grant_route_immutable();

-- ---------------------------------------------------------------- revisión manual (evidencia real, no suite)
CREATE TABLE IF NOT EXISTS ai_manual_review (
  review_id       TEXT PRIMARY KEY,
  route_id        TEXT NOT NULL REFERENCES ai_route_revision(route_id) ON DELETE RESTRICT,
  use_case_id     TEXT NOT NULL REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  environment     TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('accept','reject')),
  notes           TEXT NOT NULL CHECK (length(notes) BETWEEN 10 AND 2000),
  checklist       JSONB NOT NULL,
  invocation_ids  JSONB NOT NULL,   -- array de invocation_id revisados
  snapshot        JSONB NOT NULL,   -- por invocación: ids, hashes, proveedor, costo, latencia (sin contenido)
  snapshot_sha256 TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  actor_roles     TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_manual_review_route ON ai_manual_review(route_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_ai_manual_review_immutable ON ai_manual_review;
CREATE TRIGGER trg_ai_manual_review_immutable BEFORE UPDATE OR DELETE ON ai_manual_review
  FOR EACH ROW EXECUTE FUNCTION ai_forbid_mutation();

-- ---------------------------------------------------------------- columnas nuevas
-- Revisión manual que marcó la ruta TESTED (NULL si fue la suite automática o sigue DRAFT).
ALTER TABLE ai_route_revision ADD COLUMN IF NOT EXISTS tested_manual_review_id TEXT;
-- Job creado bajo un grant: el worker revalida el grant antes de cada intento.
ALTER TABLE ai_job ADD COLUMN IF NOT EXISTS lab_grant_id TEXT;
-- Invocación bajo grant (assignment manual_lab) y hash de la salida (JSON canónico o bytes de imagen):
-- sobrevive a la purga de contenido por retención para que la evidencia aceptada siga verificable.
ALTER TABLE ai_invocation ADD COLUMN IF NOT EXISTS lab_grant_id TEXT;
ALTER TABLE ai_invocation ADD COLUMN IF NOT EXISTS output_sha256 TEXT;
ALTER TABLE ai_invocation DROP CONSTRAINT IF EXISTS ai_invocation_assignment_check;
ALTER TABLE ai_invocation ADD CONSTRAINT ai_invocation_assignment_check
  CHECK (assignment IN ('active','canary','pinned','eval','manual_lab'));
CREATE INDEX IF NOT EXISTS idx_ai_invocation_lab_grant ON ai_invocation(lab_grant_id) WHERE lab_grant_id IS NOT NULL;
