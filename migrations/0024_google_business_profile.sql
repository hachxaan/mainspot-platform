-- DEV-E2E-04 §2A: Google Business Profile REAL por negocio. Migración aditiva.
--
-- 1) gbp_profile admite el modo real: la ficha local es una copia de lo leído en Google (read-back)
--    y `sync_status` dice qué pasó con el último guardado: synced (todo aplicado y confirmado con
--    nueva lectura), partial (algún campo no soportado quedó pendiente/unsupported), failed.
--    Nunca se marca `simulated_synced` en modo real.
ALTER TABLE gbp_profile DROP CONSTRAINT IF EXISTS gbp_profile_sync_mode_check;
ALTER TABLE gbp_profile ADD CONSTRAINT gbp_profile_sync_mode_check
  CHECK (sync_mode IN ('simulated','not_verified','real'));
ALTER TABLE gbp_profile DROP CONSTRAINT IF EXISTS gbp_profile_sync_status_check;
ALTER TABLE gbp_profile ADD CONSTRAINT gbp_profile_sync_status_check
  CHECK (sync_status IN ('simulated_synced','simulated_pending_verification','not_verified','synced','partial','failed'));
-- Nombre de recurso de Google (locations/{id}) de donde se leyó la ficha; nunca el tenant_id.
ALTER TABLE gbp_profile ADD COLUMN IF NOT EXISTS google_location_name TEXT;
-- Detalle del último guardado real: campos aplicados, no soportados y la lectura de confirmación.
ALTER TABLE gbp_profile ADD COLUMN IF NOT EXISTS sync_detail JSONB NOT NULL DEFAULT '{}';
ALTER TABLE gbp_profile ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

-- 2) review: trazabilidad del contenido de Google (política de almacenamiento ≤ 30 días) y
--    reconciliación de respuestas hechas fuera de MainSpot.
--    source_review_id de una reseña real = nombre de recurso v4 accounts/{a}/locations/{l}/reviews/{r}.
ALTER TABLE review ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
ALTER TABLE review ADD COLUMN IF NOT EXISTS google_synced_at TIMESTAMPTZ;
ALTER TABLE review ADD COLUMN IF NOT EXISTS reply_origin TEXT CHECK (reply_origin IN ('mainspot','google'));
ALTER TABLE review ADD COLUMN IF NOT EXISTS content_purged_at TIMESTAMPTZ;
ALTER TABLE engagement_case ADD COLUMN IF NOT EXISTS content_purged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_review_google_purge ON review (tenant_id, created_at) WHERE content_purged_at IS NULL;

-- 3) Cursor de ingesta incremental por negocio (updateTime de la última reseña vista).
CREATE TABLE IF NOT EXISTS google_review_cursor (
  tenant_id         TEXT PRIMARY KEY REFERENCES client(client_id) ON DELETE RESTRICT,
  location_parent   TEXT NOT NULL,          -- accounts/{a}/locations/{l} al que pertenece el cursor
  last_update_time  TIMESTAMPTZ,
  last_synced_at    TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
