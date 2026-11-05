-- Telegram como canal de conversación con MainSpot (no solo avisos): los mensajes libres de un chat vinculado entran
-- al mismo pipeline del panel, las propuestas se confirman, publican o descartan con comandos explícitos y la
-- persona puede elegir usar su autorización de laboratorio (DEC-0074) para la edición con IA. Migración aditiva.

-- Autorización de laboratorio elegida en el chat (/laboratorio). Revalidada en cada uso; nunca es permiso por sí sola.
ALTER TABLE telegram_link ADD COLUMN IF NOT EXISTS lab_grant_id TEXT REFERENCES ai_lab_grant(grant_id) ON DELETE SET NULL;

-- Una publicación aprobada desde Telegram queda registrada con su origen.
ALTER TABLE publication DROP CONSTRAINT IF EXISTS publication_source_check;
ALTER TABLE publication ADD CONSTRAINT publication_source_check CHECK (source IN ('backoffice','preview','telegram'));
