-- DEV-E2E-04 (P1+P4 Meta): scheduler automático de publicaciones sociales y libro de
-- respuestas a comentarios de Meta.
--
-- 1) scheduled_post pasa de «tick manual» a cola reclamable por varios procesos:
--    - 'publishing' = fila reclamada por un worker (claim_token + lease_until). Si el worker
--      muere, al vencer el lease la fila vuelve a 'scheduled' (proveedor idempotente) o pasa a
--      'uncertain' (proveedor real sin idempotencia nativa): NUNCA se reenvía a ciegas.
--    - 'uncertain' = resultado desconocido tras timeout/caída; se reconcilia consultando al
--      proveedor y, si no es posible, termina en revisión humana ('failed', last_error).
--    - 'failed'    = reintentos agotados o fallo no recuperable; social_post queda 'failed'.
--    - attempts/next_attempt_at: reintentos acotados con backoff exponencial.
--    - publish_key: clave de idempotencia local (una por fila) para el proveedor.
-- 2) provider_reply_ledger: una respuesta pública por (tenant, idempotency_key). Si el envío
--    se interrumpe ('sending'), el reintento reconcilia leyendo las respuestas del proveedor
--    antes de volver a enviar: sin respuestas duplicadas.
-- Idempotente por ejecución de migración; aditiva (no borra ni reescribe historial).

ALTER TABLE scheduled_post DROP CONSTRAINT IF EXISTS scheduled_post_status_check;
ALTER TABLE scheduled_post ADD CONSTRAINT scheduled_post_status_check
  CHECK (status IN ('pending','scheduled','publishing','uncertain','published','skipped','blocked','failed'));

ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS claim_token      TEXT;
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS lease_until      TIMESTAMPTZ;
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS attempts         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS next_attempt_at  TIMESTAMPTZ;
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS last_error       TEXT;
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS uncertain_since  TIMESTAMPTZ;
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS publish_key      TEXT;
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- Filas existentes: clave de idempotencia derivada del id de cola (estable y única).
UPDATE scheduled_post SET publish_key = scheduled_post_id WHERE publish_key IS NULL;

-- Reclamo por todos los tenants: vencidas y reintentables, sin lease activo.
CREATE INDEX IF NOT EXISTS idx_scheduled_post_due
  ON scheduled_post (publish_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_scheduled_post_leased
  ON scheduled_post (lease_until) WHERE status = 'publishing';
CREATE INDEX IF NOT EXISTS idx_scheduled_post_uncertain
  ON scheduled_post (uncertain_since) WHERE status = 'uncertain';

-- Respuestas públicas a comentarios: una por clave de idempotencia y tenant.
CREATE TABLE IF NOT EXISTS provider_reply_ledger (
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  idempotency_key  TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('meta_pages')),
  target_ref       TEXT NOT NULL,
  text_hash        TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('sending','sent','failed')),
  external_ref     TEXT,
  last_error       TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
