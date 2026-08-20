-- MainSpot INC-003 — administrable website (web en el contenedor del cliente, DEC-017)
--                + subdominio MainSpot en modo simulado (DEC-019, DEC-026).
-- Canonical anchors: CAP-001, CAP-010, REQ-012, REQ-018, FLOW-006, DEC-017/019/026.
-- Idempotent per migration run.
-- FKs reference client(client_id) with ON DELETE RESTRICT.

-- Modelo de la web del cliente. La web "reside en el contenedor del cliente" (DEC-017):
-- en el piloto se representa como sitio estático versionado (website_content) renderizado
-- desde los datos de negocio (site data). Una fila por tenant.
CREATE TABLE IF NOT EXISTS client_website (
  website_id        TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL UNIQUE REFERENCES client(client_id) ON DELETE RESTRICT,
  slug              TEXT NOT NULL UNIQUE,            -- usado para el subdominio simulado <slug>.sim.mainspot.local
  site_name         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','suspended')),
  data              JSONB NOT NULL DEFAULT '{}',     -- business data: name, line, services, hours, contact (REQ-012)
  published_version INT NOT NULL DEFAULT 0,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aprovisionamiento de dominio/certificado (FLOW-006, DEC-019). Modo simulado por defecto
-- (DEC-026): subdominio MainSpot por cliente; proveedor real Hostinger solo con credenciales.
CREATE TABLE IF NOT EXISTS client_domain (
  domain_id   TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  subdomain   TEXT NOT NULL UNIQUE,                  -- e.g. 'el-sol.mainspot.local'
  provider    TEXT NOT NULL DEFAULT 'simulated' CHECK (provider IN ('simulated','hostinger')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dns_provisioned','cert_issued','active','failed')),
  dns_record  JSONB NOT NULL DEFAULT '{}',
  cert_info   JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subdomain)
);
CREATE INDEX IF NOT EXISTS idx_client_domain_tenant ON client_domain(tenant_id);

-- Sitio publicado (snapshot por versión). Solo se inserta tras aprobación humana (RULE-003).
CREATE TABLE IF NOT EXISTS website_content (
  content_id   TEXT PRIMARY KEY,
  website_id   TEXT NOT NULL REFERENCES client_website(website_id) ON DELETE RESTRICT,
  tenant_id    TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  version      INT NOT NULL,
  html         TEXT NOT NULL,                        -- sitio estático renderizado (tenant-scoped)
  diff_summary TEXT NOT NULL,                        -- resumen en lenguaje claro de lo publicado
  published_by TEXT NOT NULL,
  proposal_id  TEXT REFERENCES action_proposal(proposal_id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (website_id, version)
);
CREATE INDEX IF NOT EXISTS idx_website_content_tenant ON website_content(tenant_id);

-- Seed idempotente de sitios iniciales para los 2 tenants de prueba (AC-002 fixture).
-- No rompe el seed existente (0002): solo INSERTS con ON CONFLICT DO NOTHING.
INSERT INTO client_website (website_id, tenant_id, slug, site_name, status, data, published_version) VALUES
  ('site_a', 'client_a', 'el-sol', 'Restaurante El Sol', 'published', '{
      "name": "Restaurante El Sol",
      "line": "Restaurante de comida peruana",
      "about": "Cocina peruana familiar desde 2010.",
      "phone": "+51 999 111 222",
      "email": "contacto.a@example.com",
      "address": "Av. Central 123, Lima",
      "hours": "Lun a Sáb 9:00-18:00",
      "services": ["Lomo saltado", "Ají de gallina"]
    }', 1),
  ('site_b', 'client_b', 'la-luna', 'Cafetería La Luna', 'published', '{
      "name": "Cafetería La Luna",
      "line": "Cafetería y repostería artesanal",
      "about": "Café de especialidad y tortas caseras.",
      "phone": "+51 988 222 111",
      "email": "contacto.b@example.com",
      "address": "Calle Luna 456, Cusco",
      "hours": "Lun a Dom 8:00-20:00",
      "services": ["Tres leches", "Chocolate", "Café de origen"]
    }', 1)
ON CONFLICT (tenant_id) DO NOTHING;
