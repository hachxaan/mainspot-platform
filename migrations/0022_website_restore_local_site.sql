-- DEV-E2E-04 (P3): restauración de versiones de la página web + sitio local real por negocio.
--
-- 1) website_content guarda también los DATOS de negocio de cada versión (no solo el HTML): así
--    «Restaurar esta versión» genera una versión NUEVA con el contenido de la elegida sin tocar el
--    historial (nunca se reescribe ni se borra una versión). restored_from_* referencia la fuente.
--    Backfill: las versiones previas toman los datos de la propuesta que las publicó (detail.after);
--    el teléfono publicado se vuelve a resolver siempre desde «Teléfonos de contacto».
-- 2) client_website registra el estado del sitio local https://<slug>.<LOCAL_SITE_DOMAIN>: lo escribe
--    SOLO el comando de operación scripts/client-site-provision.sh (hosts + certificado de la CA local +
--    vhost en el LXC); el proceso web solo lo lee (nunca usa sudo ni toca infraestructura).
ALTER TABLE website_content ADD COLUMN IF NOT EXISTS data JSONB;
ALTER TABLE website_content ADD COLUMN IF NOT EXISTS restored_from_version INT;
ALTER TABLE website_content ADD COLUMN IF NOT EXISTS restored_from_content_id TEXT REFERENCES website_content(content_id) ON DELETE RESTRICT;

UPDATE website_content wc
   SET data = ap.detail->'after'
  FROM action_proposal ap
 WHERE ap.proposal_id = wc.proposal_id
   AND wc.data IS NULL
   AND jsonb_typeof(ap.detail->'after') = 'object';

ALTER TABLE client_website ADD COLUMN IF NOT EXISTS local_site_status TEXT
  CHECK (local_site_status IS NULL OR local_site_status IN ('provisioned','removed'));
ALTER TABLE client_website ADD COLUMN IF NOT EXISTS local_site_hostname TEXT;
ALTER TABLE client_website ADD COLUMN IF NOT EXISTS local_site_provisioned_at TIMESTAMPTZ;
ALTER TABLE client_website ADD COLUMN IF NOT EXISTS local_site_cert_not_after TIMESTAMPTZ;
