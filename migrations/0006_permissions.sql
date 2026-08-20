-- MainSpot INC-002/INC-003 — extend permission mirror for conversational/website actions.
-- Mirrors src/rbac/matrix.ts (validated by tests/integration/rbac-context.test.ts):
-- the DB snapshot must equal the code matrix WITHOUT extra sync.
-- Idempotent.

INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('conversation.read',    'conversation.read',    '*', 'allow', 'Ver solicitudes y propuestas del cliente'),
  ('conversation.send',    'conversation.send',    '*', 'allow', 'Enviar y recibir mensajes del canal'),
  ('conversation.confirm', 'conversation.confirm', '*', 'allow', 'Confirmar una propuesta y preparar su preview'),
  ('website.publish',      'website.publish',      '*', 'allow', 'Publicar la web del cliente tras aprobación'),
  ('website.provision',    'website.provision',    '*', 'allow', 'Aprovisionar el subdominio del cliente')
ON CONFLICT (permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  -- administration: todas
  ('administration', 'conversation.read'),
  ('administration', 'conversation.send'),
  ('administration', 'conversation.confirm'),
  ('administration', 'website.publish'),
  ('administration', 'website.provision'),
  -- operation: conversacional + publicación/provision (NO aprueba ni rechaza)
  ('operation', 'conversation.read'),
  ('operation', 'conversation.send'),
  ('operation', 'conversation.confirm'),
  ('operation', 'website.publish'),
  ('operation', 'website.provision'),
  -- read_only: solo lectura conversacional (no envía, no confirma, no publica)
  ('read_only', 'conversation.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;
