-- Edición web conversacional con IA: una solicitud del chat que no se resuelve con el editor determinista
-- se prepara con un job del AI Core (Jev + parche site-edit/v2). La solicitud guarda su job para que la
-- conversación muestre el avance, el bloqueo o la vista previa resultante. Migración aditiva.
ALTER TABLE conversation_request ADD COLUMN IF NOT EXISTS ai_job_id TEXT REFERENCES ai_job(job_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_request_ai_job ON conversation_request(ai_job_id) WHERE ai_job_id IS NOT NULL;
