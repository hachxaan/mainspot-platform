-- MainSpot INC-004 — reputación y reseñas (CAP-002/CAP-004, REQ-015, FLOW-004,
-- DEC-011 respuesta pública = preview/aprobación, DEC-023 umbral configurable <4).
-- Idempotent per migration run. FKs reference client(client_id) ON DELETE RESTRICT.
-- INVARIANT: NO se permite ocultar/borrar opiniones (sin manipulación); el permiso
-- reputation.hide_review está BLOQUEADO para todos los roles (fail-closed).

-- Reseña/caso detectado de Google Business Profile (modo simulado por defecto,
-- DEC-026). Estado = FLOW-004 adaptado:
--   detected → suggested → awaiting_human → approved → published
--   suggested/awaiting_human → edited (borrador corregido, no aprobado aún)
--   suggested/awaiting_human/edited → rejected ; published es terminal.
CREATE TABLE IF NOT EXISTS review (
  review_id          TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  source             TEXT NOT NULL DEFAULT 'google' CHECK (source IN ('google')),
  source_review_id   TEXT NOT NULL,                  -- id determinista del proveedor simulado
  author_name        TEXT NOT NULL,
  star_rating        INT NOT NULL CHECK (star_rating BETWEEN 1 AND 5),
  review_text        TEXT NOT NULL,
  classification     TEXT NOT NULL CHECK (classification IN ('positive','neutral','negative')),
  state              TEXT NOT NULL DEFAULT 'detected' CHECK (state IN ('detected','suggested','awaiting_human','approved','published','rejected','edited','acknowledged')),
  suggested_options  JSONB NOT NULL DEFAULT '[]',    -- 3 borradores de respuesta (FLOW-004)
  response_text      TEXT,                           -- borrador elegido por el humano (editable antes de aprobar)
  proposal_id        TEXT REFERENCES action_proposal(proposal_id) ON DELETE RESTRICT,
  decided_by         TEXT,
  decided_at         TIMESTAMPTZ,
  published_text     TEXT,
  published_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_review_id)
);
CREATE INDEX IF NOT EXISTS idx_review_tenant_ts ON review(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_tenant_state ON review(tenant_id, state);

-- Permission mirror de src/rbac/matrix.ts (reputation.*). reputation.hide_review
-- NO se inserta en role_permission (queda deny para todos, fail-closed).
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('reputation.read',        'reputation.read',        '*', 'allow', 'Ver reseñas y casos de reputación'),
  ('reputation.respond',     'reputation.respond',     '*', 'allow', 'Redactar o editar borradores de respuesta pública'),
  ('reputation.escalate',    'reputation.escalate',    '*', 'allow', 'Escalar una reseña o caso sensible a revisión humana'),
  ('reputation.approve',     'reputation.approve',     '*', 'allow', 'Aprobar la respuesta pública a una reseña'),
  ('reputation.hide_review', 'reputation.hide_review', '*', 'deny',  'Ocultar o borrar una reseña (bloqueado: sin manipulación de opiniones)')
ON CONFLICT (permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  -- administration: todo lo de reputación salvo hide_review (deny fail-closed)
  ('administration', 'reputation.read'),
  ('administration', 'reputation.respond'),
  ('administration', 'reputation.escalate'),
  ('administration', 'reputation.approve'),
  -- operation: lee, redacta y escala; NO aprueba la respuesta pública
  ('operation', 'reputation.read'),
  ('operation', 'reputation.respond'),
  ('operation', 'reputation.escalate'),
  -- read_only: solo lectura
  ('read_only', 'reputation.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;
