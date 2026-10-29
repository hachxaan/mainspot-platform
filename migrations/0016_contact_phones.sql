-- DEV-E2E-02 (handoff e2e-parallel-2026-10-29, SHARED-CONTRACT §A): teléfono principal del
-- negocio + un «Otro número» INDEPENDIENTE por integración (website, google_business_profile,
-- facebook). No existe un número alternativo global: cada fila de integration_phone guarda el
-- suyo. Migración aditiva; sin cambios en tablas existentes.

CREATE TABLE IF NOT EXISTS business_contact (
  tenant_id                TEXT PRIMARY KEY REFERENCES client(client_id) ON DELETE RESTRICT,
  primary_country_iso2     TEXT NOT NULL CHECK (primary_country_iso2 ~ '^[A-Z]{2}$'),
  primary_calling_code     TEXT NOT NULL CHECK (primary_calling_code ~ '^\+[0-9]{1,3}$'),
  primary_national_number  TEXT NOT NULL CHECK (primary_national_number ~ '^[0-9]{2,17}$'),
  primary_e164             TEXT NOT NULL CHECK (primary_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  updated_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_phone (
  tenant_id              TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  channel                TEXT NOT NULL CHECK (channel IN ('website','google_business_profile','facebook')),
  mode                   TEXT NOT NULL DEFAULT 'own' CHECK (mode IN ('own','other')),
  -- Override propio de ESTE canal; se conserva al volver a 'own' (other→own→other) hasta que
  -- el cliente lo borre de forma explícita.
  other_country_iso2     TEXT CHECK (other_country_iso2 ~ '^[A-Z]{2}$'),
  other_calling_code     TEXT CHECK (other_calling_code ~ '^\+[0-9]{1,3}$'),
  other_national_number  TEXT CHECK (other_national_number ~ '^[0-9]{2,17}$'),
  other_e164             TEXT CHECK (other_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- Estado de sincronización con el proveedor: en desarrollo siempre simulado o interno.
  sync_status            TEXT NOT NULL DEFAULT 'pending'
                           CHECK (sync_status IN ('pending','simulated_synced','applies_on_publish','not_verified')),
  synced_at              TIMESTAMPTZ,
  updated_by             TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel),
  CHECK (mode = 'own' OR other_e164 IS NOT NULL),
  CHECK ((other_e164 IS NULL) = (other_country_iso2 IS NULL)
     AND (other_e164 IS NULL) = (other_calling_code IS NULL)
     AND (other_e164 IS NULL) = (other_national_number IS NULL))
);
