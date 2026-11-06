-- MainSpot FB-3 (DEC-0078; SRC-007) — REVERSIÓN de migrations/0039_ai_budget_segregation.sql ÚNICAMENTE.
-- No revierte las demás: el orden completo es 0040 (typesafe-reservation-rollback.sql) → 0039 (este script) → 0038
-- (facebook-ai-suggestions-rollback.sql) → 0037 (consent-approval-binding-rollback.sql) → 0036 → 0035 → 0034.
--
-- EXIGE EL CÓDIGO ANTERIOR A FB-3 QUE YA CONOCE 0038 (`2905d1d` o equivalente) desplegado junto con este cambio. El de
-- 122e74d/7bbea3d no sirve mientras 0038 siga aplicada: su registro de parámetros (v2) no coincide con la BD y bloquea
-- toda escritura del catálogo de planes. El código de `2905d1d` no conoce el presupuesto experimental del laboratorio:
-- tras revertir, las pruebas con grant vuelven a gastar el `tenant_day` del negocio, las evaluaciones cuentan como
-- operación y el gasto deja de atribuirse por canal. Solo sirve para volver a un estado de laboratorio.
--
-- Uso, con la aplicación y los workers DETENIDOS y una copia de seguridad reciente (ON_ERROR_STOP: cualquier aborto
-- sale con código distinto de 0):
--   psql "$DATABASE_URL" -X -f scripts/ai-budget-segregation-rollback.sql
-- Es una sola transacción: ante cualquier error no cambia nada. Aborta sin tocar nada (SQLSTATE 55000) si 0039 no
-- está registrada, si hay migraciones posteriores registradas, o si existe la fila `lab_experiment`: es un presupuesto
-- que fijó un platform_admin (con motivo y auditoría) y el esquema anterior no puede guardarlo, así que revertir lo
-- borraría. En ese caso, retirarlo de forma explícita y auditada, restaurar una copia de seguridad o corregir hacia
-- delante. `ai_use_case.channel` no se protege: es el mapa fijo de la migración y del catálogo, y reaplicar 0039 lo
-- reconstruye igual.
--
-- Resultado: ai_budget vuelve a admitir solo lab_total, platform_month y tenant_day; desaparecen
-- ai_budget_lab_experiment_global_check y ai_use_case.channel con su restricción; schema_migrations olvida 0039
-- (puede reaplicarse).

\set ON_ERROR_STOP on
-- READ COMMITTED explícito: la comprobación debe ver los datos posteriores al LOCK de abajo.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '15s';
DO $$
DECLARE
  lab_rows INT;
BEGIN
  -- Mismo candado que scripts/migrate.ts: nunca en paralelo con una migración.
  PERFORM pg_advisory_xact_lock(hashtext('mainspot_migrations'));
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file = '0039_ai_budget_segregation.sql') THEN
    RAISE EXCEPTION 'ai-budget-segregation-rollback: migration 0039 is not applied in this database; nothing to revert'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Nadie puede fijar un presupuesto, reservar gasto ni crear casos de uso entre la comprobación y el cambio.
  LOCK TABLE ai_budget, ai_use_case IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0039_ai_budget_segregation.sql') THEN
    RAISE EXCEPTION 'ai-budget-segregation-rollback: migrations after 0039 are applied; review and revert them first'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO lab_rows FROM ai_budget WHERE scope = 'lab_experiment';
  IF lab_rows > 0 THEN
    RAISE EXCEPTION 'ai-budget-segregation-rollback BLOCKED: % lab_experiment budget row(s) are configured; the previous schema cannot hold them and reverting would delete a budget set by a platform_admin. Remove it explicitly, restore a backup or fix forward.', lab_rows
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

ALTER TABLE ai_use_case DROP CONSTRAINT ai_use_case_channel_check;
ALTER TABLE ai_use_case DROP COLUMN channel;

ALTER TABLE ai_budget DROP CONSTRAINT ai_budget_lab_experiment_global_check;
ALTER TABLE ai_budget DROP CONSTRAINT ai_budget_scope_check;
ALTER TABLE ai_budget ADD CONSTRAINT ai_budget_scope_check CHECK (scope IN ('lab_total','platform_month','tenant_day'));

DELETE FROM schema_migrations WHERE file = '0039_ai_budget_segregation.sql';
COMMIT;
