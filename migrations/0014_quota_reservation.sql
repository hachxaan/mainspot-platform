-- MainSpot DEC-0005 (TOCTOU) + NFR-0001 (DEC-0014): comprobación y consumo de cuota
-- atómicos por tenant, con auditoría en la misma transacción.
-- Una fila por consumo (o reserva) de unidades de una capacidad del plan:
--   reserved  → unidades apartadas mientras la operación termina (cuentan como uso
--               hasta expires_at; las vencidas no cuentan y la reconciliación las
--               marca expired);
--   committed → la operación persistió su recurso en la MISMA transacción (el uso
--               lo cuenta ya la tabla de dominio; la fila queda como evidencia);
--   released  → la operación falló y devolvió las unidades;
--   expired   → nunca se confirmó (caída a mitad) y la reconciliación la cerró.
-- La clave (tenant, capacidad, idempotency_key) hace idempotente cada consumo.
-- FK con ON DELETE RESTRICT (nunca cascade de datos de tenant). Sin datos personales.
-- Idempotent per migration run (IF NOT EXISTS + advisory lock in runner).

CREATE TABLE IF NOT EXISTS quota_reservation (
  reservation_id   TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  capability       TEXT NOT NULL CHECK (capability IN ('website','social_posts','social_ads','reviews_managed','agents','conversations')),
  units            INT  NOT NULL CHECK (units > 0),
  idempotency_key  TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_id       TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('reserved','committed','released','expired')),
  resource_ref     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  settled_at       TIMESTAMPTZ,
  CHECK ((state = 'reserved') = (settled_at IS NULL)),
  CHECK (state <> 'committed' OR resource_ref IS NOT NULL),
  UNIQUE (tenant_id, capability, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_quota_reservation_active
  ON quota_reservation(tenant_id, capability) WHERE state = 'reserved';
CREATE INDEX IF NOT EXISTS idx_quota_reservation_expiry
  ON quota_reservation(expires_at) WHERE state = 'reserved';
