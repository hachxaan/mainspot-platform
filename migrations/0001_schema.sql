-- MainSpot INC-001 — schema v1 (identity / tenant / rbac / audit / evidence fixtures)
-- Canonical anchors: REQ-008, REQ-009, REQ-010, RULE-001; DESIGN-INC-001 §3/§4/§6.
-- Idempotent per migration run (table-level IF [NOT] EXISTS + advisory lock in runner).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Base of the tenant: a client. Never shares data with other clients (REQ-008).
CREATE TABLE IF NOT EXISTS client (
  client_id     TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  contact_email TEXT, -- SENSITIVE: stored, never emitted to audit/logs
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Explicit tenant boundary marker (DESIGN-INC-001 §3: TenantContext).
CREATE TABLE IF NOT EXISTS tenant_context (
  tenant_context_id TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES client(client_id),
  config            JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Internal backoffice user (REQ-010, DEC-009).
-- tenant_id (nullable in 0001, enforced NOT NULL by 0003): in v1 an internal
-- account belongs to exactly one tenant; the compound UNIQUE (login, tenant)
-- is created by 0003 (replaces the old global UNIQUE on login — IR-05).
CREATE TABLE IF NOT EXISTS internal_user (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  login         TEXT NOT NULL UNIQUE, -- v1: global UNIQUE removed by 0003
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  tenant_id     TEXT REFERENCES client(client_id),
  password_hash TEXT NOT NULL,        -- SENSITIVE: pgcrypto bcrypt hash; never emitted to audit/logs
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The three contract roles: administration / operation / read_only (AC-001).
CREATE TABLE IF NOT EXISTS role (
  role_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (name IN ('administration','operation','read_only')),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Declarative permission mirror of src/rbac/matrix.ts (kept in sync by seed + tests).
CREATE TABLE IF NOT EXISTS permission (
  permission_id TEXT PRIMARY KEY,
  action        TEXT NOT NULL,
  resource      TEXT NOT NULL DEFAULT '*',
  effect        TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  description   TEXT,
  UNIQUE (action, resource)
);

CREATE TABLE IF NOT EXISTS role_permission (
  role_id       TEXT NOT NULL REFERENCES role(role_id),
  permission_id TEXT NOT NULL REFERENCES permission(permission_id),
  PRIMARY KEY (role_id, permission_id)
);

-- A user holds a role inside a tenant (activation scoped per tenant).
CREATE TABLE IF NOT EXISTS user_role (
  user_id    TEXT NOT NULL REFERENCES internal_user(user_id),
  role_id    TEXT NOT NULL REFERENCES role(role_id),
  tenant_id  TEXT NOT NULL REFERENCES client(client_id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id, tenant_id)
);

-- Server-side session referenced by the own minimal JWT (DEC-022).
CREATE TABLE IF NOT EXISTS session_context (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES internal_user(user_id),
  tenant_id   TEXT NOT NULL REFERENCES client(client_id),
  role_id     TEXT NOT NULL REFERENCES role(role_id),
  permissions JSONB NOT NULL DEFAULT '[]', -- informational snapshot (display); authz re-checks code matrix
  source      TEXT NOT NULL DEFAULT 'backoffice',
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_session_context_user ON session_context(user_id);

-- Tenant-owned demo data used to prove data-boundary enforcement (AC-002).
CREATE TABLE IF NOT EXISTS client_data (
  data_id    TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES client(client_id),
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_data_tenant ON client_data(tenant_id);

-- Demo/evidence fixture for AC-003 (create/approve/reject/execute).
-- NOT the INC-002 approval domain: no preview, no publication, no external effect.
CREATE TABLE IF NOT EXISTS demo_action (
  action_id    TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES client(client_id),
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','approved','rejected','executed')),
  created_by   TEXT NOT NULL,
  decided_by   TEXT,
  executed_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demo_action_tenant ON demo_action(tenant_id);

-- Audit events (AC-003). No FK on tenant_id/actor_id on purpose: denies BEFORE
-- a tenant/actor is resolved use the reserved values 'unknown'.
-- NEVER store credentials/tokens/credentials of external channels (INVARIANT).
CREATE TABLE IF NOT EXISTS audit_event (
  event_id          TEXT PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         TEXT NOT NULL,
  actor_id          TEXT NOT NULL,
  actor_role        TEXT,
  action            TEXT NOT NULL,
  resource          TEXT,
  request_id        TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  result            TEXT NOT NULL,
  evidence_ref      TEXT,
  created_by_system TEXT NOT NULL DEFAULT 'mainspot-backoffice-api'
);
CREATE INDEX IF NOT EXISTS idx_audit_event_request_id ON audit_event(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_tenant_ts ON audit_event(tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_tenant_request ON audit_event(tenant_id, request_id);
