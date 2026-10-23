-- MainSpot DEC-0033/DEC-0034 (QS-0008) — gate D4 sobre el resultado final del sistema.
-- Un caso de riesgo falla si el resultado final (reglas + Jev + D1–D3) no es bloqueo,
-- aprobación humana ni aclaración. La cifra de Jev solo (definición anterior) se guarda
-- como información. Cada evaluación queda ligada a los bytes del código que decide.
-- Idempotent per migration run.

ALTER TABLE jev_evaluation_run ADD COLUMN IF NOT EXISTS risk_definition TEXT NOT NULL DEFAULT 'jev_only';
ALTER TABLE jev_evaluation_run ADD COLUMN IF NOT EXISTS jev_risky_misses INT;
ALTER TABLE jev_evaluation_run ADD COLUMN IF NOT EXISTS decision_code_sha256 TEXT;

-- Ejecuciones anteriores: su risky_misses ya es la cifra de Jev solo.
UPDATE jev_evaluation_run SET jev_risky_misses = risky_misses
 WHERE risk_definition = 'jev_only' AND jev_risky_misses IS NULL;

ALTER TABLE jev_evaluation_run DROP CONSTRAINT IF EXISTS jev_evaluation_run_risk_definition_check;
ALTER TABLE jev_evaluation_run ADD CONSTRAINT jev_evaluation_run_risk_definition_check CHECK (
  (risk_definition = 'jev_only' AND decision_code_sha256 IS NULL)
  OR (risk_definition = 'final_outcome' AND decision_code_sha256 ~ '^[0-9a-f]{64}$'
      AND jev_risky_misses IS NOT NULL AND jev_risky_misses BETWEEN 0 AND risky_cases)
);
