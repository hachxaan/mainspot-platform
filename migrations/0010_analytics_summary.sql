-- MainSpot INC-007 base — analítica mínima + export ETL (CAP-014 base, REQ-021
-- P3, DEC-025 retención configurable default 90 días + export ETL).
-- SIN dashboards completos ni research (fase 2 fuera de este bloque).
-- Idempotent per migration run.

-- Resumen diario por acción/resultado (contadores). Se alimenta por SELECT/upsert
-- desde audit_event (sin ETL externo). UNIQUE (tenant_id, day, action, result).
CREATE TABLE IF NOT EXISTS analytics_daily_summary (
  summary_id  TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  day         DATE NOT NULL,
  action      TEXT NOT NULL,
  result      TEXT NOT NULL,
  count       INT NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, day, action, result)
);
CREATE INDEX IF NOT EXISTS idx_analytics_summary_tenant_day ON analytics_daily_summary(tenant_id, day);

-- Índice para la purga por retención (DEC-025) sobre audit_event.ts.
CREATE INDEX IF NOT EXISTS idx_audit_event_ts_retention ON audit_event(ts);

-- Permission mirror de src/rbac/matrix.ts (analytics.*).
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('analytics.read',   'analytics.read',   '*', 'allow', 'Ver resúmenes de actividad del cliente'),
  ('analytics.export', 'analytics.export', '*', 'allow', 'Exportar eventos de auditoría del cliente'),
  ('analytics.purge',  'analytics.purge',  '*', 'allow', 'Aplicar la retención de eventos del cliente')
ON CONFLICT (permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  ('administration', 'analytics.read'),
  ('administration', 'analytics.export'),
  ('administration', 'analytics.purge'),
  ('operation', 'analytics.read'),
  ('read_only', 'analytics.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;
