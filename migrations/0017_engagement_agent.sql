-- DEV-E2E-02 (SHARED-CONTRACT §B): agente de atención por políticas para reseñas de Google y
-- comentarios de Facebook. Migración aditiva.
--   engagement_policy        políticas opt-in versionadas (append-only, revocables)
--   engagement_case          caso por interacción entrante (dedupe tenant+origin+external_ref)
--   engagement_cursor        cursor/backoff del observador por tenant y origen
--   engagement_notification  aviso Telegram por (caso, chat): sin duplicados
--   telegram_link(_code)     chat de Telegram vinculado a una persona del tenant (≠ teléfono público)
--   sim_provider_*           simulador determinista de proveedores (desarrollo; sin red)

CREATE TABLE IF NOT EXISTS engagement_policy (
  policy_id                  TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin                     TEXT NOT NULL CHECK (origin IN ('google_review','facebook_comment')),
  category                   TEXT NOT NULL CHECK (category IN ('gratitude','basic_info')),
  mode                       TEXT NOT NULL CHECK (mode IN ('review_required','safe_auto_reply')),
  version                    INT NOT NULL CHECK (version >= 1),
  max_auto_replies_per_hour  INT NOT NULL DEFAULT 10 CHECK (max_auto_replies_per_hour BETWEEN 1 AND 60),
  consent_text               TEXT NOT NULL,
  decided_by                 TEXT NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, origin, category, version)
);
CREATE INDEX IF NOT EXISTS idx_engagement_policy_current ON engagement_policy(tenant_id, origin, category, version DESC);

CREATE TABLE IF NOT EXISTS engagement_case (
  case_id                 TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin                  TEXT NOT NULL CHECK (origin IN ('google_review','facebook_comment')),
  external_ref            TEXT NOT NULL,
  review_id               TEXT REFERENCES review(review_id) ON DELETE RESTRICT,
  post_id                 TEXT REFERENCES social_post(post_id) ON DELETE RESTRICT,
  author_label            TEXT NOT NULL,
  body                    TEXT NOT NULL,
  rating                  INT CHECK (rating BETWEEN 1 AND 5),
  category                TEXT CHECK (category IN ('gratitude','basic_info','other')),
  risk_flags              JSONB NOT NULL DEFAULT '[]',
  confidence              NUMERIC(3,2),
  policy_id               TEXT REFERENCES engagement_policy(policy_id) ON DELETE RESTRICT,
  policy_version          INT,
  decision                TEXT CHECK (decision IN ('auto_reply','human_review')),
  reason                  TEXT,
  classified_at           TIMESTAMPTZ,
  state                   TEXT NOT NULL DEFAULT 'received' CHECK (state IN (
                            'received','classified','responding','responded','needs_human',
                            'approved','rejected','retry_pending','failed','closed_elsewhere')),
  drafts                  JSONB NOT NULL DEFAULT '[]',
  response_text           TEXT,
  resolved_by             TEXT,
  resolution_channel      TEXT CHECK (resolution_channel IN ('auto','panel','telegram')),
  resolved_at             TIMESTAMPTZ,
  attempts                INT NOT NULL DEFAULT 0,
  next_attempt_at         TIMESTAMPTZ,
  lease_until             TIMESTAMPTZ,
  last_error              TEXT,
  delivery_mode           TEXT CHECK (delivery_mode IN ('simulated','real')),
  responded_external_ref  TEXT,
  responded_at            TIMESTAMPTZ,
  notify_status           TEXT CHECK (notify_status IN ('pending','sent','no_destination','failed')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, origin, external_ref),
  CHECK (jsonb_typeof(drafts) = 'array' AND jsonb_array_length(drafts) <= 3)
);
CREATE INDEX IF NOT EXISTS idx_engagement_case_tenant_state ON engagement_case(tenant_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_engagement_case_due ON engagement_case(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS engagement_cursor (
  tenant_id             TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin                TEXT NOT NULL CHECK (origin IN ('google_review','facebook_comment')),
  cursor                TEXT,
  last_polled_at        TIMESTAMPTZ,
  next_poll_at          TIMESTAMPTZ,
  consecutive_failures  INT NOT NULL DEFAULT 0,
  last_error            TEXT,
  PRIMARY KEY (tenant_id, origin)
);

CREATE TABLE IF NOT EXISTS telegram_link (
  tenant_id   TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  user_id     TEXT NOT NULL REFERENCES internal_user(user_id) ON DELETE RESTRICT,
  chat_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, user_id)
);
-- Un chat solo puede estar vinculado a una persona activa a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_link_active_chat ON telegram_link(chat_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS telegram_link_code (
  code_hash   TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  user_id     TEXT NOT NULL REFERENCES internal_user(user_id) ON DELETE RESTRICT,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telegram_link_code_user ON telegram_link_code(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS engagement_notification (
  notification_id  TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  case_id          TEXT NOT NULL REFERENCES engagement_case(case_id) ON DELETE RESTRICT,
  chat_id          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, chat_id)
);

-- Simulador determinista de proveedores (Google reseñas / Facebook comentarios). Solo
-- desarrollo: los datos son ficticios y nunca salen a la red.
CREATE TABLE IF NOT EXISTS sim_provider_event (
  event_seq     BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin        TEXT NOT NULL CHECK (origin IN ('google_review','facebook_comment')),
  external_ref  TEXT NOT NULL,
  post_ref      TEXT,
  author_label  TEXT NOT NULL,
  body          TEXT NOT NULL,
  rating        INT CHECK (rating BETWEEN 1 AND 5),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, origin, external_ref)
);

CREATE TABLE IF NOT EXISTS sim_provider_reply (
  idempotency_key  TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin           TEXT NOT NULL CHECK (origin IN ('google_review','facebook_comment')),
  target_ref       TEXT NOT NULL,
  text             TEXT NOT NULL,
  external_ref     TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fallos inyectables del simulador (pruebas de reintento/timeout entre procesos).
CREATE TABLE IF NOT EXISTS sim_provider_fault (
  tenant_id  TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  origin     TEXT NOT NULL CHECK (origin IN ('google_review','facebook_comment','telegram')),
  kind       TEXT NOT NULL CHECK (kind IN ('error','timeout','list_error')),
  remaining  INT NOT NULL CHECK (remaining >= 0),
  PRIMARY KEY (tenant_id, origin, kind)
);

-- Ficha de Google Business Profile / presencia en Maps gestionada en SIMULACIÓN. El teléfono
-- público de la ficha NO se guarda aquí: es el efectivo del canal google_business_profile.
CREATE TABLE IF NOT EXISTS gbp_profile (
  tenant_id         TEXT PRIMARY KEY REFERENCES client(client_id) ON DELETE RESTRICT,
  business_name     TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 120),
  primary_category  TEXT NOT NULL CHECK (char_length(primary_category) BETWEEN 1 AND 80),
  description       TEXT CHECK (char_length(description) <= 750),
  address_line      TEXT CHECK (char_length(address_line) <= 200),
  locality          TEXT CHECK (char_length(locality) <= 80),
  region            TEXT CHECK (char_length(region) <= 80),
  postal_code       TEXT CHECK (char_length(postal_code) <= 12),
  country_iso2      TEXT CHECK (country_iso2 ~ '^[A-Z]{2}$'),
  latitude          NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude         NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
  hours             JSONB NOT NULL DEFAULT '[]',
  website_url       TEXT CHECK (char_length(website_url) <= 300),
  sync_mode         TEXT NOT NULL DEFAULT 'simulated' CHECK (sync_mode IN ('simulated','not_verified')),
  sync_status       TEXT NOT NULL DEFAULT 'simulated_synced'
                      CHECK (sync_status IN ('simulated_synced','simulated_pending_verification','not_verified')),
  synced_at         TIMESTAMPTZ,
  updated_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Permisos (espejo de src/rbac/matrix.ts).
INSERT INTO permission (permission_id, action, resource, effect, description) VALUES
  ('engagement.read',          'engagement.read',          '*', 'allow', 'Ver casos del agente de atención y sus políticas'),
  ('engagement.respond',       'engagement.respond',       '*', 'allow', 'Editar borradores de respuesta de un caso'),
  ('engagement.approve',       'engagement.approve',       '*', 'allow', 'Aprobar o rechazar la respuesta pública de un caso'),
  ('engagement.policy.manage', 'engagement.policy.manage', '*', 'allow', 'Activar o revocar respuestas automáticas seguras'),
  ('telegram.link',            'telegram.link',            '*', 'allow', 'Vincular el propio chat de Telegram para avisos')
ON CONFLICT (permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id) VALUES
  ('administration', 'engagement.read'),
  ('administration', 'engagement.respond'),
  ('administration', 'engagement.approve'),
  ('administration', 'engagement.policy.manage'),
  ('administration', 'telegram.link'),
  ('operation', 'engagement.read'),
  ('operation', 'engagement.respond'),
  ('operation', 'telegram.link'),
  ('read_only', 'engagement.read')
ON CONFLICT (role_id, permission_id) DO NOTHING;
