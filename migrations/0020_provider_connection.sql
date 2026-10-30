-- DEV-E2E-04: conexión REAL de cada negocio con un proveedor externo (Google Business Profile,
-- Meta Pages). Sustituye el token global de proceso como credencial de negocio: el recurso
-- externo (cuenta/ubicación de Google, Page de Meta) se guarda tal cual lo devuelve el proveedor,
-- nunca se deriva del tenant_id.
--
-- Los tokens (access/refresh/page token) solo existen cifrados con AES-256-GCM
-- (src/connectors/secret-box.ts, clave CONNECTOR_TOKEN_KEY fuera de Git) y ligados al par
-- tenant/proveedor como datos autenticados: copiar el cifrado a otra fila no lo descifra.
-- status refleja lo último que se comprobó contra el proveedor; nunca se marca `connected` sin
-- una llamada autenticada que lo confirme.
CREATE TABLE IF NOT EXISTS provider_connection (
  connection_id          TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  provider               TEXT NOT NULL CHECK (provider IN ('google_business_profile','meta_pages')),
  status                 TEXT NOT NULL CHECK (status IN (
                           'needs_authorization','connected','permission_missing',
                           'disconnected','failed','provider_unavailable')),
  external_account_id    TEXT,
  external_resource_id   TEXT,
  external_resource_name TEXT,
  scopes                 TEXT[] NOT NULL DEFAULT '{}',
  token_box              BYTEA,
  token_key_id           TEXT,
  token_expires_at       TIMESTAMPTZ,
  last_verified_at       TIMESTAMPTZ,
  last_error_code        TEXT,
  connected_by           TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider),
  -- Sin token cifrado no puede haber conexión utilizable.
  CHECK (status <> 'connected' OR (token_box IS NOT NULL AND external_resource_id IS NOT NULL))
);

-- OAuth 2.0: `state` de un solo uso por negocio/usuario/proveedor. Se guarda solo el hash del
-- state y el verificador PKCE cifrado; caduca en minutos y se consume de forma atómica.
CREATE TABLE IF NOT EXISTS provider_oauth_state (
  state_hash     TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  user_id        TEXT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('google_business_profile','meta_pages')),
  verifier_box   BYTEA,
  redirect_uri   TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_oauth_state_expiry ON provider_oauth_state (expires_at);
