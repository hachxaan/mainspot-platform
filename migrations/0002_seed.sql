-- MainSpot INC-001 — dev seed: 2 tenants + 3 roles + users + data (AC-002 precondition).
-- Idempotent: every INSERT uses ON CONFLICT DO NOTHING.
-- PASSWORDS ARE SIMULATED (dev only). Real credentials never live in this repo.

-- 2 clients (tenants)
INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES
  ('client_a', 'Restaurante El Sol (cliente de prueba A)', 'active', 'contacto.a@example.com', '{"demo": true, "vertical": "restaurant"}'),
  ('client_b', 'Cafetería La Luna (cliente de prueba B)', 'active', 'contacto.b@example.com', '{"demo": true, "vertical": "coffee"}')
ON CONFLICT (client_id) DO NOTHING;

INSERT INTO tenant_context (tenant_context_id, client_id, config, status) VALUES
  ('tenant_ctx_a', 'client_a', '{}', 'active'),
  ('tenant_ctx_b', 'client_b', '{}', 'active')
ON CONFLICT (tenant_context_id) DO NOTHING;

-- Roles (contract: administration / operation / read_only)
INSERT INTO role (role_id, name, description) VALUES
  ('administration', 'administration', 'Perfil de administración: gestiona usuarios, configuración y auditoría.'),
  ('operation',     'operation',     'Perfil de operación: registra y ejecuta operaciones dentro de su cliente.'),
  ('read_only',     'read_only',     'Perfil de solo lectura: consulta datos autorizados sin modificar nada.')
ON CONFLICT (role_id) DO NOTHING;

-- Permission mirror of src/rbac/matrix.ts (10 actions)
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('user.manage',           'user.manage',           '*', 'allow', 'Gestionar usuarios y roles'),
  ('client.config.manage',  'client.config.manage',  '*', 'allow', 'Configurar el cliente'),
  ('audit.read',            'audit.read',            '*', 'allow', 'Ver el registro de auditoría'),
  ('audit.export',          'audit.export',          '*', 'allow', 'Exportar el registro de auditoría'),
  ('operation.create',      'operation.create',      '*', 'allow', 'Crear una operación de prueba'),
  ('operation.execute',     'operation.execute',     '*', 'allow', 'Ejecutar operaciones'),
  ('operation.approve',     'operation.approve',     '*', 'allow', 'Aprobar operaciones'),
  ('operation.reject',      'operation.reject',      '*', 'allow', 'Rechazar operaciones'),
  ('data.read',             'data.read',             '*', 'allow', 'Ver los datos del cliente'),
  ('data.write',            'data.write',            '*', 'allow', 'Registrar datos del cliente')
ON CONFLICT (permission_id) DO NOTHING;

-- Role -> permission (mirror of MATRIX)
INSERT INTO role_permission (role_id, permission_id) VALUES
  -- administration: all
  ('administration', 'user.manage'),
  ('administration', 'client.config.manage'),
  ('administration', 'audit.read'),
  ('administration', 'audit.export'),
  ('administration', 'operation.create'),
  ('administration', 'operation.execute'),
  ('administration', 'operation.approve'),
  ('administration', 'operation.reject'),
  ('administration', 'data.read'),
  ('administration', 'data.write'),
  -- operation
  ('operation', 'operation.create'),
  ('operation', 'operation.execute'),
  ('operation', 'data.read'),
  ('operation', 'data.write'),
  -- read_only
  ('read_only', 'data.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Internal users (SIMULATED credentials; see README "Credenciales de prueba")
INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES
  -- tenant A
  ('user_a_admin',  'Ana Administradora',  'admin.a@example.com',  'active', 'client_a', crypt('Simula-A-Admin-2026!',   gen_salt('bf', 10))),
  ('user_a_ops',    'Óscar Operador',      'ops.a@example.com',    'active', 'client_a', crypt('Simula-A-Ops-2026!',     gen_salt('bf', 10))),
  ('user_a_reader', 'Rosa Lectura',        'reader.a@example.com', 'active', 'client_a', crypt('Simula-A-Reader-2026!',  gen_salt('bf', 10))),
  -- tenant B
  ('user_b_admin',  'Bruno Administrador', 'admin.b@example.com',  'active', 'client_b', crypt('Simula-B-Admin-2026!',   gen_salt('bf', 10))),
  ('user_b_ops',    'Berta Operadora',     'ops.b@example.com',    'active', 'client_b', crypt('Simula-B-Ops-2026!',     gen_salt('bf', 10))),
  ('user_b_reader', 'Beto Lectura',        'reader.b@example.com', 'active', 'client_b', crypt('Simula-B-Reader-2026!',  gen_salt('bf', 10)))
ON CONFLICT (user_id) DO NOTHING;

-- Role activations per tenant
INSERT INTO user_role (user_id, role_id, tenant_id) VALUES
  ('user_a_admin',  'administration', 'client_a'),
  ('user_a_ops',    'operation',      'client_a'),
  ('user_a_reader', 'read_only',      'client_a'),
  ('user_b_admin',  'administration', 'client_b'),
  ('user_b_ops',    'operation',      'client_b'),
  ('user_b_reader', 'read_only',      'client_b')
ON CONFLICT (user_id, role_id, tenant_id) DO NOTHING;

-- Tenant-owned demo data (isolation fixtures)
INSERT INTO client_data (data_id, tenant_id, kind, payload) VALUES
  ('data_a_001', 'client_a', 'client.asset', '{"name": "Horario de atención", "value": "Lun a Sáb 9:00-18:00"}'),
  ('data_a_002', 'client_a', 'client.asset', '{"name": "Menú del día", "value": {"items": ["Lomo saltado", "Ají de gallina"]}}'),
  ('data_b_001', 'client_b', 'client.asset', '{"name": "Catálogo de tortas", "value": {"items": ["Tres leches", "Chocolate"]}}')
ON CONFLICT (data_id) DO NOTHING;
