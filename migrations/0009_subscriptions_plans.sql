-- MainSpot INC-006 — suscripciones, planes y límites (CAP-012, REQ-019, DEC-024).
-- Catálogo CONFIGURABLE, SIN precios reales, SIN cobro ni procesador de pagos
-- en el piloto (interfaz PaymentProvider abstracta + SimulatedPaymentProvider).
-- Un cliente activo tiene UNA suscripción (UNIQUE tenant_id).
-- Idempotent per migration run. FKs ON DELETE RESTRICT.

-- Plan del catálogo. price_cents NULL = sin precio aprobado (no se puede facturar).
CREATE TABLE IF NOT EXISTS plan (
  plan_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  price_cents INT,                       -- NULL => sin precio (DEC-024/RULE-006)
  currency    TEXT,
  is_pilot    BOOLEAN NOT NULL DEFAULT false,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Límites por capacidad (RULE-006: composición/límites PROPUESTOS, configurables).
-- capability: website | social_posts | social_ads | reviews_managed | agents | conversations
CREATE TABLE IF NOT EXISTS plan_limit (
  limit_id    TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plan(plan_id) ON DELETE RESTRICT,
  capability  TEXT NOT NULL,
  max_value   INT NOT NULL CHECK (max_value >= 0),
  UNIQUE (plan_id, capability)
);

-- Suscripción del cliente (una activa por tenant en el piloto).
CREATE TABLE IF NOT EXISTS subscription (
  subscription_id TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL UNIQUE REFERENCES client(client_id) ON DELETE RESTRICT,
  plan_id         TEXT NOT NULL REFERENCES plan(plan_id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed idempotente: plan piloto ÚNICO sin precio + planes opcionales sin precio.
INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES
  ('plan_piloto_1', 'Piloto 1', 'Plan único del piloto de validación (sin precio aprobado; DEC-024).', NULL, NULL, true, true),
  ('plan_basico',   'Básico',   'Plan opcional de referencia (sin precio aprobado; DEC-024).',         NULL, NULL, false, true),
  ('plan_completo', 'Completo', 'Plan opcional de referencia (sin precio aprobado; DEC-024).',         NULL, NULL, false, true)
ON CONFLICT (plan_id) DO NOTHING;

INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES
  ('limit_piloto_website',        'plan_piloto_1', 'website',        1),
  ('limit_piloto_social_posts',   'plan_piloto_1', 'social_posts',   10),
  ('limit_piloto_social_ads',     'plan_piloto_1', 'social_ads',     5),
  ('limit_piloto_reviews',        'plan_piloto_1', 'reviews_managed',20),
  ('limit_piloto_agents',         'plan_piloto_1', 'agents',         5),
  ('limit_piloto_conversations',  'plan_piloto_1', 'conversations',  500),
  ('limit_basico_website',        'plan_basico',   'website',        1),
  ('limit_basico_social_posts',   'plan_basico',   'social_posts',   3),
  ('limit_basico_social_ads',     'plan_basico',   'social_ads',     0),
  ('limit_basico_reviews',        'plan_basico',   'reviews_managed',5),
  ('limit_completo_website',      'plan_completo', 'website',        1),
  ('limit_completo_social_posts', 'plan_completo', 'social_posts',   50),
  ('limit_completo_social_ads',   'plan_completo', 'social_ads',     20),
  ('limit_completo_reviews',      'plan_completo', 'reviews_managed',100)
ON CONFLICT (limit_id) DO NOTHING;

-- Asignación inicial a los 2 tenants de prueba (idempotente).
INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES
  ('sub_a', 'client_a', 'plan_piloto_1', 'active'),
  ('sub_b', 'client_b', 'plan_piloto_1', 'active')
ON CONFLICT (tenant_id) DO NOTHING;

-- Permission mirror de src/rbac/matrix.ts (subscription.*).
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('subscription.admin', 'subscription.admin', '*', 'allow', 'Asignar el plan de suscripción del cliente y gestionar su facturación'),
  ('subscription.read',  'subscription.read',  '*', 'allow', 'Ver el plan y los límites del cliente')
ON CONFLICT (permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  ('administration', 'subscription.admin'),
  ('administration', 'subscription.read'),
  ('operation', 'subscription.read'),
  ('read_only', 'subscription.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;
