-- MainSpot DEC-0077 (SRC-0017, SRC-0016) — salvaguardas previas a producción de la cuota de respuestas con IA.
-- Migración ADITIVA y transaccional (el runner ejecuta el archivo completo en una transacción). Re-ejecutable.
--
-- SEC-CONSENT-01 — consentimiento informado y versionado:
--   1. engagement_policy.consent_version / consent_sha256: versión de los términos aceptados y huella sha256 del texto
--      literal guardado. Las políticas anteriores quedan SIN versión: su consentimiento no menciona la cuota compartida,
--      así que el código no les permite gastar respuestas con IA hasta que el negocio acepte los términos vigentes.
--   2. Toda política `safe_auto_reply` nueva registra versión y huella (CHECK NOT VALID: no recorre las filas previas).
--   3. engagement_policy es append-only (sin UPDATE) y la huella debe corresponder al texto (trigger de guarda).
--
-- SEC-TG-APPROVAL-01 — `/aprobar` publica solo lo que se mostró:
--   4. engagement_case.drafts_revision: sube con cada cambio de `drafts` (trigger; no se puede fijar desde SQL).
--   5. engagement_approval_offer: instantánea inmutable de cada aviso de Telegram (chat, persona, código de un solo uso,
--      revisión y opciones mostradas con su huella). Solo cambia su estado: active → used | superseded, y → purged
--      (opciones vacías) por la purga de contenido de Google.
--   6. Al subir la revisión de un caso, sus avisos activos anteriores pasan a `superseded` (trigger AFTER UPDATE).
--
-- No toca consentimientos, casos ni avisos existentes salvo añadir columnas con su valor por defecto.
-- Reversión (solo mientras no exista ningún consentimiento versionado ni aviso registrado):
-- scripts/consent-approval-binding-rollback.sql.

-- ---------------------------------------------------------------------------------------------- SEC-CONSENT-01
ALTER TABLE engagement_policy ADD COLUMN IF NOT EXISTS consent_version TEXT;
ALTER TABLE engagement_policy ADD COLUMN IF NOT EXISTS consent_sha256 TEXT;

-- Restricciones NOT VALID (como 0036): no recorren las tablas con el candado exclusivo; las filas previas las cumplen
-- por construcción (columnas nuevas nulas o con su valor por defecto) y las nuevas o modificadas se comprueban.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_policy_consent_shape') THEN
    ALTER TABLE engagement_policy ADD CONSTRAINT engagement_policy_consent_shape CHECK (
      (consent_version IS NULL) = (consent_sha256 IS NULL)
      AND (consent_version IS NULL OR consent_version ~ '^[a-z_]+(\.[a-z_]+)*\.v[0-9]+$')
      AND (consent_sha256 IS NULL OR consent_sha256 ~ '^[0-9a-f]{64}$')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_policy_auto_reply_consent') THEN
    ALTER TABLE engagement_policy ADD CONSTRAINT engagement_policy_auto_reply_consent
      CHECK (mode <> 'safe_auto_reply' OR consent_version IS NOT NULL) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION engagement_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'engagement_policy is append-only: record a new version instead of updating %', OLD.policy_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.consent_sha256 IS NOT NULL
     AND NEW.consent_sha256 <> encode(sha256(convert_to(NEW.consent_text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'engagement_policy.consent_sha256 does not match the stored consent text'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_engagement_policy_guard BEFORE INSERT OR UPDATE ON engagement_policy
  FOR EACH ROW EXECUTE FUNCTION engagement_policy_guard();

-- ------------------------------------------------------------------------------------------ SEC-TG-APPROVAL-01
ALTER TABLE engagement_case ADD COLUMN IF NOT EXISTS drafts_revision INT NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'engagement_case_drafts_revision_check') THEN
    ALTER TABLE engagement_case ADD CONSTRAINT engagement_case_drafts_revision_check CHECK (drafts_revision >= 1) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION engagement_case_drafts_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.drafts_revision := 1;
  ELSIF NEW.drafts IS DISTINCT FROM OLD.drafts THEN
    NEW.drafts_revision := OLD.drafts_revision + 1;
  ELSE
    NEW.drafts_revision := OLD.drafts_revision;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_engagement_case_drafts_revision BEFORE INSERT OR UPDATE ON engagement_case
  FOR EACH ROW EXECUTE FUNCTION engagement_case_drafts_revision();

CREATE TABLE IF NOT EXISTS engagement_approval_offer (
  offer_id         TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  case_id          TEXT NOT NULL REFERENCES engagement_case(case_id) ON DELETE RESTRICT,
  notification_id  TEXT NOT NULL REFERENCES engagement_notification(notification_id) ON DELETE RESTRICT,
  chat_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES internal_user(user_id) ON DELETE RESTRICT,
  code             TEXT NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  drafts_revision  INT NOT NULL CHECK (drafts_revision >= 1),
  options          JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 3),
  options_sha256   TEXT NOT NULL CHECK (options_sha256 ~ '^[0-9a-f]{64}$'),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','superseded','purged')),
  used_option      INT CHECK (used_option BETWEEN 1 AND 3),
  used_at          TIMESTAMPTZ,
  superseded_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, code),
  CHECK ((status = 'used') = (used_option IS NOT NULL AND used_at IS NOT NULL) OR status = 'purged'),
  CHECK (status <> 'purged' OR options = '[]'::jsonb)
);
CREATE INDEX IF NOT EXISTS idx_engagement_approval_offer_case ON engagement_approval_offer(case_id, status);
CREATE INDEX IF NOT EXISTS idx_engagement_approval_offer_tenant ON engagement_approval_offer(tenant_id);

CREATE OR REPLACE FUNCTION engagement_approval_offer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.offer_id <> OLD.offer_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.case_id <> OLD.case_id
     OR NEW.notification_id <> OLD.notification_id OR NEW.chat_id <> OLD.chat_id OR NEW.user_id <> OLD.user_id
     OR NEW.code <> OLD.code OR NEW.drafts_revision <> OLD.drafts_revision OR NEW.options_sha256 <> OLD.options_sha256
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'engagement_approval_offer % is immutable; only its status may change', OLD.offer_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'purged' THEN
    -- La purga solo vacía las opciones: qué se aprobó y cuándo (o cuándo se sustituyó) no se reescribe.
    IF NEW.used_option IS DISTINCT FROM OLD.used_option OR NEW.used_at IS DISTINCT FROM OLD.used_at
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'engagement_approval_offer %: purging only empties the options', OLD.offer_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.options IS DISTINCT FROM OLD.options OR OLD.status = 'purged' THEN
    RAISE EXCEPTION 'engagement_approval_offer %: the options shown cannot change', OLD.offer_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.used_option IS DISTINCT FROM OLD.used_option OR NEW.used_at IS DISTINCT FROM OLD.used_at
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'engagement_approval_offer %: status fields only change with the status', OLD.offer_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' OR (NEW.status = 'superseded' AND NEW.superseded_at IS NULL) THEN
    RAISE EXCEPTION 'engagement_approval_offer %: transition % -> % is not allowed', OLD.offer_id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_engagement_approval_offer_guard BEFORE UPDATE ON engagement_approval_offer
  FOR EACH ROW EXECUTE FUNCTION engagement_approval_offer_guard();

-- Mismo orden de candados que la aprobación (caso y después aviso): sin interbloqueos con `/aprobar`.
CREATE OR REPLACE FUNCTION engagement_case_supersede_offers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE engagement_approval_offer SET status = 'superseded', superseded_at = now()
   WHERE case_id = NEW.case_id AND status = 'active' AND drafts_revision < NEW.drafts_revision;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_engagement_case_supersede_offers AFTER UPDATE ON engagement_case
  FOR EACH ROW WHEN (NEW.drafts_revision <> OLD.drafts_revision) EXECUTE FUNCTION engagement_case_supersede_offers();
