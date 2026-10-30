-- Webhook de Telegram: entregas repetidas o concurrentes del MISMO update no se procesan dos
-- veces. Telegram reenvía un update mientras no reciba 2xx; `update_id` es único y creciente
-- por bot. Solo se guarda el identificador del update, quién lo reclamó y el resultado
-- (sin cuerpo del mensaje, sin chat id ni datos personales).
--   processing  reclamado por un intento (claim_token). Si received_at envejece más que la
--               lease (TelegramLinkService: UPDATE_LEASE_SECONDS) otro intento puede reclamarlo;
--               si el intento falla con error, libera la fila y el reintento lo reprocesa.
--   done        procesado; cualquier reentrega devuelve `duplicate` sin tocar nada.
CREATE TABLE IF NOT EXISTS telegram_update (
  update_id    BIGINT PRIMARY KEY,
  claim_token  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','done')),
  handled      TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at      TIMESTAMPTZ
);
