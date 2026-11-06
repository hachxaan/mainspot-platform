-- MainSpot DEC-0078 (SRC-007, TS-1) — REVERSIÓN de migrations/0040_typesafe_reservation.sql ÚNICAMENTE.
-- No revierte migraciones anteriores: cada una tiene su propio script y se revierten en orden inverso (0040 primero).
--
-- EXIGE EL CÓDIGO ANTERIOR A TS-1 QUE YA CONOCE 0038 Y 0039 (`3368a31` o equivalente) desplegado junto con este cambio.
-- El de 122e74d/7bbea3d no sirve mientras 0038 siga aplicada (registro de parámetros v2: el catálogo de planes queda
-- bloqueado para escribir). El código de `3368a31` vuelve a comprobar el tope de TypeSafe (DEC-0032) sumando
-- jev_classification, jev_evaluation_run y ai_invocation, sin reserva (HUECO-TS-1 reabierto). Con el código de TS-1
-- sobre el esquema revertido, toda llamada a TypeSafe falla al reservar (fail-closed). Solo sirve para volver a un
-- estado de laboratorio; nunca para producción.
--
-- Uso, con la aplicación y los workers DETENIDOS y una copia de seguridad reciente (ON_ERROR_STOP: cualquier aborto
-- sale con código distinto de 0):
--   psql "$DATABASE_URL" -X -f scripts/typesafe-reservation-rollback.sql
-- Es una sola transacción: ante cualquier error no cambia nada. Aborta sin tocar nada (SQLSTATE 55000) si 0040 no está
-- registrada, si hay migraciones posteriores registradas o si existe alguna reserva registrada después de 0040 (fuente
-- distinta de `legacy`): es la única cuenta del gasto de las llamadas fallidas tras enviar, de las solicitudes del chat
-- no guardadas y de las reservas en curso, y revertir la borraría. En ese caso, restaurar una copia de seguridad o
-- corregir hacia delante.
--
-- Resultado: desaparece typesafe_reservation con sus índices y restricciones (las filas `legacy` se recalculan desde las
-- tablas de origen si 0040 se reaplica); schema_migrations olvida 0040 (puede reaplicarse).

\set ON_ERROR_STOP on
-- READ COMMITTED explícito: la comprobación debe ver los datos posteriores al LOCK de abajo.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '15s';
DO $$
DECLARE
  reservation_rows INT;
BEGIN
  -- Mismo candado que scripts/migrate.ts: nunca en paralelo con una migración.
  PERFORM pg_advisory_xact_lock(hashtext('mainspot_migrations'));
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file = '0040_typesafe_reservation.sql') THEN
    RAISE EXCEPTION 'typesafe-reservation-rollback: migration 0040 is not applied in this database; nothing to revert'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Nadie puede reservar, enviar ni confirmar una llamada a TypeSafe entre la comprobación y el cambio.
  LOCK TABLE typesafe_reservation IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0040_typesafe_reservation.sql') THEN
    RAISE EXCEPTION 'typesafe-reservation-rollback: migrations after 0040 are applied; review and revert them first'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO reservation_rows FROM typesafe_reservation WHERE source <> 'legacy';
  IF reservation_rows > 0 THEN
    RAISE EXCEPTION 'typesafe-reservation-rollback BLOCKED: % TypeSafe reservation(s) were recorded after 0040; reverting would delete the only record of their spend against the DEC-0032 daily cap. Restore a backup or fix forward.', reservation_rows
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

DROP TABLE typesafe_reservation;

DELETE FROM schema_migrations WHERE file = '0040_typesafe_reservation.sql';
COMMIT;
