-- MainSpot PR-01 (Reviewer) — gate de aprobación en la cola de programación.
-- La cola scheduled_post SOLO debe existir tras aprobación humana:
--   - nueva fila creada por SocialPublisher al aprobar (status 'scheduled',
--     proposal_id → action_proposal) — nunca por schedule().
--   - el tick solo procesa filas 'scheduled' con evidencia de publicación.
--   - 'blocked' = fila huérfana/legacy sin aprobación (nunca auto-publicada).
-- Idempotent per migration run.

-- 1. Ampliar el CHECK de estado de la cola.
ALTER TABLE scheduled_post DROP CONSTRAINT IF EXISTS scheduled_post_status_check;
ALTER TABLE scheduled_post ADD CONSTRAINT scheduled_post_status_check
  CHECK (status IN ('pending','scheduled','published','skipped','blocked'));

-- 2. Vincular cada fila de la cola con la proposal aprobada (FK RESTRICT).
ALTER TABLE scheduled_post ADD COLUMN IF NOT EXISTS proposal_id TEXT
  REFERENCES action_proposal(proposal_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_scheduled_post_proposal ON scheduled_post(proposal_id);

-- 3. Backfill de filas legacy ('pending' creadas por el flujo anterior):
--    - con propuesta aprobada y publicación registrada → 'scheduled'
--      (esperando el tick; se conserva la intención de publicación).
--    - sin evidencia de aprobación → 'blocked' (no se auto-publican).
UPDATE scheduled_post sp
   SET proposal_id = p.proposal_id
  FROM social_post p
 WHERE sp.post_id = p.post_id
   AND sp.proposal_id IS NULL
   AND p.proposal_id IS NOT NULL;

UPDATE scheduled_post sp
   SET status = 'scheduled'
 WHERE sp.status = 'pending'
   AND EXISTS (
     SELECT 1
       FROM social_post p
      WHERE p.post_id = sp.post_id
        AND p.tenant_id = sp.tenant_id
        AND p.proposal_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM action_proposal ap
           WHERE ap.proposal_id = p.proposal_id
             AND ap.status IN ('published','approved_for_publish'))
        AND EXISTS (
          SELECT 1 FROM publication pb
           WHERE pb.proposal_id = p.proposal_id)
   );

UPDATE scheduled_post SET status = 'blocked' WHERE status = 'pending';
