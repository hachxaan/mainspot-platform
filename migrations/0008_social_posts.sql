-- MainSpot INC-005 — redes sociales (CAP-003, REQ-014, DEC-017/026).
-- Facebook publicaciones y Facebook Ads básicos con modo simulado funcional.
-- Campañas avanzadas/Instagram FUERA del MVP: permiso social.campaign_advanced
-- queda BLOQUEADO (deny) para todos los roles.
-- Idempotent per migration run. FKs ON DELETE RESTRICT.

-- Publicación social (post o ad básico). Estado del contenido:
--   draft → awaiting_approval → preview/approved(pending) → published|rejected
--   El "publish" visible se registra en scheduled_post cuando hay fecha futura.
CREATE TABLE IF NOT EXISTS social_post (
  post_id            TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  network            TEXT NOT NULL DEFAULT 'facebook' CHECK (network IN ('facebook')),
  content_type       TEXT NOT NULL DEFAULT 'post' CHECK (content_type IN ('post','ad')),
  text               TEXT NOT NULL,
  image_url          TEXT,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','awaiting_approval','scheduled','published','rejected','failed')),
  scheduled_at       TIMESTAMPTZ,
  published_at       TIMESTAMPTZ,
  proposal_id        TEXT REFERENCES action_proposal(proposal_id) ON DELETE RESTRICT,
  external_ref       TEXT,                            -- ref del proveedor simulado/real (idempotente)
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_post_tenant_ts ON social_post(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_post_tenant_status ON social_post(tenant_id, status);

-- Cola de programación: worker simple que "publica" en el simulador al llegar
-- la fecha (tick manual para pruebas). Una fila por post programado.
CREATE TABLE IF NOT EXISTS scheduled_post (
  scheduled_post_id  TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  post_id            TEXT NOT NULL UNIQUE REFERENCES social_post(post_id) ON DELETE RESTRICT,
  publish_at         TIMESTAMPTZ NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','skipped')),
  external_ref       TEXT,
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_post_tenant_status_due ON scheduled_post(tenant_id, status, publish_at);

-- Permission mirror de src/rbac/matrix.ts (social.*).
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('social.read',             'social.read',             '*', 'allow', 'Ver publicaciones y contenido social'),
  ('social.create',           'social.create',           '*', 'allow', 'Crear borradores de publicaciones sociales'),
  ('social.schedule',         'social.schedule',         '*', 'allow', 'Programar publicaciones sociales con aprobación'),
  ('social.approve',          'social.approve',          '*', 'allow', 'Aprobar una publicación social para revisión y vista previa'),
  ('social.campaign_advanced','social.campaign_advanced','*', 'deny',  'Crear campañas avanzadas en redes (bloqueado: fuera del MVP)')
ON CONFLICT (permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  ('administration', 'social.read'),
  ('administration', 'social.create'),
  ('administration', 'social.schedule'),
  ('administration', 'social.approve'),
  ('operation', 'social.read'),
  ('operation', 'social.create'),
  ('operation', 'social.schedule'),
  ('read_only', 'social.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;
