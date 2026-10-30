-- AI Core (FR-0013..FR-0017): permisos del negocio, espejo de src/rbac/matrix.ts.
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('brand.read',       'brand.read',       '*', 'allow', 'Ver la memoria de marca del negocio'),
  ('brand.manage',     'brand.manage',     '*', 'allow', 'Confirmar o cambiar los datos de la marca'),
  ('ai.generate',      'ai.generate',      '*', 'allow', 'Pedir a MainSpot diseños, textos e imágenes'),
  ('media.read',       'media.read',       '*', 'allow', 'Ver la biblioteca de imágenes'),
  ('media.manage',     'media.manage',     '*', 'allow', 'Subir, aprobar o archivar imágenes'),
  ('assistant.ask',    'assistant.ask',    '*', 'allow', 'Preguntar al asistente por el estado de la cuenta'),
  ('campaign.plan',    'campaign.plan',    '*', 'allow', 'Preparar propuestas de campaña (sin gasto)'),
  ('campaign.approve', 'campaign.approve', '*', 'allow', 'Aprobar el plan de una campaña (no autoriza gasto)'),
  ('insights.read',    'insights.read',    '*', 'allow', 'Ver resúmenes y recomendaciones del negocio')
ON CONFLICT (permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  ('administration', 'brand.read'), ('administration', 'brand.manage'), ('administration', 'ai.generate'),
  ('administration', 'media.read'), ('administration', 'media.manage'), ('administration', 'assistant.ask'),
  ('administration', 'campaign.plan'), ('administration', 'campaign.approve'), ('administration', 'insights.read'),
  ('operation', 'brand.read'), ('operation', 'ai.generate'), ('operation', 'media.read'), ('operation', 'media.manage'),
  ('operation', 'assistant.ask'), ('operation', 'campaign.plan'), ('operation', 'insights.read'),
  ('read_only', 'brand.read'), ('read_only', 'media.read'), ('read_only', 'assistant.ask'), ('read_only', 'insights.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;
