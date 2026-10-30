-- DEV-E2E-04 (P2): recuperación de contraseña por correo con enlace de UN SOLO USO.
-- El token nunca se guarda en claro (solo su SHA-256); caduca a los 30 minutos, se consume de
-- forma atómica y una solicitud nueva anula las anteriores pendientes del mismo correo.

-- Momento del último cambio de contraseña: toda sesión emitida ANTES deja de ser válida
-- (defensa en profundidad además de revocar las filas de session_context en el mismo cambio).
ALTER TABLE internal_user ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS password_reset_token (
  reset_id      TEXT PRIMARY KEY,
  login         TEXT NOT NULL,            -- SENSITIVE: correo; nunca en auditoría ni registros
  token_hash    TEXT NOT NULL UNIQUE,     -- SHA-256 del token; el token en claro solo viaja en el correo
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','superseded')),
  delivery      TEXT NOT NULL DEFAULT 'pending' CHECK (delivery IN ('pending','sent','failed','disabled')),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_login_pending ON password_reset_token(login) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_password_reset_created ON password_reset_token(created_at);
