-- MainSpot INC-002 — conversational intake + preview/approval state machine (FLOW-002).
-- Canonical anchors: AC-004..AC-007, REQ-005/006/007, RULE-002/003/004/005, CAP-008, FLOW-002.
-- Idempotent per migration run (table-level IF [NOT] EXISTS + advisory lock in runner).
-- FKs reference client(client_id) with ON DELETE RESTRICT (never cascade tenant data).
-- INVARIANT: audit NEVER stores tokens; preview tokens are stored hashed (preview_session.token_hash).

-- A user request received from a channel (FLOW-001/FLOW-003).
-- The raw message is tenant-scoped data (REQ-008/NFR-004); it is NOT copied into audit events.
CREATE TABLE IF NOT EXISTS conversation_request (
  request_id       TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  actor_id         TEXT NOT NULL,                    -- resolved identity (INC-001) or channel handle
  channel          TEXT NOT NULL CHECK (channel IN ('telegram','simulated')),
  raw_message      TEXT NOT NULL,                    -- SENSITIVE-ish: tenant data, never emitted to audit
  intent           TEXT NOT NULL,                    -- e.g. 'website.edit.contact', 'query.info'
  capability_target TEXT NOT NULL,                   -- e.g. 'website', 'domain', 'unknown'
  action_class     TEXT NOT NULL CHECK (action_class IN ('read_only','draft','preview_required','human_approval_required','prohibited')),
  status           TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','classified','answered','awaiting_confirmation','needs_approval','blocked','needs_clarification')),
  response_message TEXT,                             -- plain-language reply sent back to the channel
  proposal_id      TEXT,                             -- linked proposal when one was drafted (set by pipeline)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversation_request_tenant_ts ON conversation_request(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_request_tenant_status ON conversation_request(tenant_id, status);

-- A proposed change (draft / preview candidate). State machine = FLOW-002:
--   drafted -> awaiting_confirmation -> confirmed -> preview_ready
--          -> approved_for_publish -> published
--   any pre-publish state -> rejected ; preview expiry -> expired ; publisher failure -> failed
CREATE TABLE IF NOT EXISTS action_proposal (
  proposal_id        TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  request_id         TEXT NOT NULL REFERENCES conversation_request(request_id) ON DELETE RESTRICT,
  capability_target  TEXT NOT NULL,
  proposal_type      TEXT NOT NULL,                  -- e.g. 'website.edit.contact', 'website.add_section'
  action_class       TEXT NOT NULL CHECK (action_class IN ('draft','preview_required','human_approval_required')),
  summary            TEXT NOT NULL,                  -- diff conceptual en lenguaje claro (AC-006)
  detail             JSONB NOT NULL DEFAULT '{}',    -- payload aplicable por el publisher (tenant-scoped)
  status             TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','awaiting_confirmation','confirmed','preview_ready','approved_for_publish','published','rejected','expired','failed')),
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by       TEXT,
  confirmed_at       TIMESTAMPTZ,
  preview_id         TEXT,
  approved_by        TEXT,
  approved_at        TIMESTAMPTZ,
  rejected_by        TEXT,
  rejected_at        TIMESTAMPTZ,
  published_version  INT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_proposal_tenant_status ON action_proposal(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_action_proposal_tenant_ts ON action_proposal(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_proposal_request ON action_proposal(request_id);

-- Preview/sandbox session with a SAFE link token (CAP-008, FLOW-002 "enlace seguro").
-- TENTATIVA: token aleatorio de alta entropía, alcance limitado a UN proposal,
-- expiración configurable (PREVIEW_TOKEN_TTL_MINUTES), single-use para "Aplicar cambios".
CREATE TABLE IF NOT EXISTS preview_session (
  preview_id   TEXT PRIMARY KEY,
  proposal_id  TEXT NOT NULL UNIQUE REFERENCES action_proposal(proposal_id) ON DELETE RESTRICT,
  tenant_id    TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  token_hash   TEXT NOT NULL,                        -- SHA-256 del token; NUNCA el token crudo (NFR-004)
  scope        TEXT NOT NULL DEFAULT 'proposal_publish',  -- alcance limitado (TENTATIVA)
  expires_at   TIMESTAMPTZ NOT NULL,
  created_by   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','used')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_preview_session_tenant ON preview_session(tenant_id);

-- Human approval / rejection decision (REQ-007, RULE-004). Approved_by = authorized operator.
CREATE TABLE IF NOT EXISTS approval (
  approval_id  TEXT PRIMARY KEY,
  proposal_id  TEXT NOT NULL REFERENCES action_proposal(proposal_id) ON DELETE RESTRICT,
  tenant_id    TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  approved_by  TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  request_id   TEXT NOT NULL,                        -- correlation with audit events (REQ-009)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_proposal ON approval(proposal_id);

-- Idempotent publication record (AC-007, FLOW-002 "identificador único de publicación").
-- Idempotency key = (proposal_id, attempt); publish_key is unique per proposal+attempt so
-- repeating an approval can NEVER duplicate a publication (ON CONFLICT is the backstop).
CREATE TABLE IF NOT EXISTS publication (
  publication_id   TEXT PRIMARY KEY,
  proposal_id      TEXT NOT NULL REFERENCES action_proposal(proposal_id) ON DELETE RESTRICT,
  tenant_id        TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  publish_key      TEXT NOT NULL UNIQUE,             -- 'pub_' + proposal_id + '_' + attempt
  attempt          INT NOT NULL,
  publisher        TEXT NOT NULL,                    -- e.g. 'website', 'stub'
  status           TEXT NOT NULL CHECK (status IN ('published','failed')),
  published_version INT,
  external_ref     TEXT,
  published_by     TEXT NOT NULL,                    -- approved_by (operator) or 'preview_token'
  source           TEXT NOT NULL DEFAULT 'backoffice' CHECK (source IN ('backoffice','preview')),
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_publication_proposal ON publication(proposal_id);
CREATE INDEX IF NOT EXISTS idx_publication_tenant ON publication(tenant_id);
