-- MainSpot DEC-0077 (SRC-0017) — REVERSIÓN de migrations/0037_consent_and_approval_binding.sql ÚNICAMENTE.
-- No revierte 0036: el orden completo es 0037 (este script) → 0036 (commercial-quota-rollback.sql) → 0035 → 0034.
--
-- EXIGE EL CÓDIGO ANTERIOR (PR #16/#17, `b809510` o equivalente) desplegado junto con este cambio. Ese código NO
-- aplica SEC-CONSENT-01 ni SEC-TG-APPROVAL-01: tras revertir, las respuestas automáticas con consentimiento previo
-- vuelven a gastar la cuota y `/aprobar` vuelve a publicar la opción vigente. Solo sirve para volver a un estado de
-- laboratorio; nunca para producción.
--
-- Uso, con la aplicación y los workers DETENIDOS y una copia de seguridad reciente (ON_ERROR_STOP: cualquier aborto
-- sale con código distinto de 0):
--   psql "$DATABASE_URL" -X -f scripts/consent-approval-binding-rollback.sql
-- Es una sola transacción: ante cualquier error no cambia nada. Aborta sin tocar nada (SQLSTATE 55000) si 0037 no
-- está registrada, si hay migraciones posteriores registradas, o si existe algún consentimiento versionado o algún
-- aviso de aprobación registrado: son la prueba de qué aceptó y qué vio cada persona, y revertir los borraría. En ese
-- caso, restaurar una copia de seguridad o corregir hacia delante.
--
-- Resultado: desaparecen engagement_approval_offer, engagement_case.drafts_revision, engagement_policy.consent_version
-- y consent_sha256 con sus restricciones, triggers y funciones; schema_migrations olvida 0037 (puede reaplicarse).

\set ON_ERROR_STOP on
-- READ COMMITTED explícito: la comprobación debe ver los datos posteriores al LOCK de abajo.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '15s';
DO $$
DECLARE
  consent_rows INT;
  offer_rows INT;
BEGIN
  -- Mismo candado que scripts/migrate.ts: nunca en paralelo con una migración.
  PERFORM pg_advisory_xact_lock(hashtext('mainspot_migrations'));
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE file = '0037_consent_and_approval_binding.sql') THEN
    RAISE EXCEPTION 'consent-approval-binding-rollback: migration 0037 is not applied in this database; nothing to revert'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Nadie puede aceptar términos, avisar ni aprobar entre la comprobación y el cambio.
  LOCK TABLE engagement_policy, engagement_case, engagement_notification, engagement_approval_offer IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE file COLLATE "C" > '0037_consent_and_approval_binding.sql') THEN
    RAISE EXCEPTION 'consent-approval-binding-rollback: migrations after 0037 are applied; review and revert them first'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT count(*) INTO consent_rows FROM engagement_policy WHERE consent_version IS NOT NULL;
  SELECT count(*) INTO offer_rows FROM engagement_approval_offer;
  IF consent_rows > 0 OR offer_rows > 0 THEN
    RAISE EXCEPTION 'consent-approval-binding-rollback BLOCKED: % versioned consent(s) and % approval notice(s) are recorded; reverting would delete the evidence of what each person accepted and saw. Restore a backup or fix forward.', consent_rows, offer_rows
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

DROP TRIGGER trg_engagement_case_supersede_offers ON engagement_case;
DROP FUNCTION engagement_case_supersede_offers();
DROP TRIGGER trg_engagement_approval_offer_guard ON engagement_approval_offer;
DROP FUNCTION engagement_approval_offer_guard();
DROP TABLE engagement_approval_offer;

DROP TRIGGER trg_engagement_case_drafts_revision ON engagement_case;
DROP FUNCTION engagement_case_drafts_revision();
ALTER TABLE engagement_case DROP CONSTRAINT engagement_case_drafts_revision_check;
ALTER TABLE engagement_case DROP COLUMN drafts_revision;

DROP TRIGGER trg_engagement_policy_guard ON engagement_policy;
DROP FUNCTION engagement_policy_guard();
ALTER TABLE engagement_policy DROP CONSTRAINT engagement_policy_auto_reply_consent;
ALTER TABLE engagement_policy DROP CONSTRAINT engagement_policy_consent_shape;
ALTER TABLE engagement_policy DROP COLUMN consent_sha256;
ALTER TABLE engagement_policy DROP COLUMN consent_version;

DELETE FROM schema_migrations WHERE file = '0037_consent_and_approval_binding.sql';
COMMIT;
