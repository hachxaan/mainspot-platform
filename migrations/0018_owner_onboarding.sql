-- DEV-E2E-02 (FLOW-01): alta asistida del dueño del negocio con invitación de UN SOLO USO.
-- El token nunca se guarda en claro (solo su SHA-256); caduca y se anula al usarse.

CREATE TABLE IF NOT EXISTS owner_invitation (
  invitation_id  TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  email          TEXT NOT NULL,           -- SENSITIVE: nunca en auditoría ni registros
  token_hash     TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','revoked')),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  used_by        TEXT,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_owner_invitation_tenant ON owner_invitation(tenant_id, status);
