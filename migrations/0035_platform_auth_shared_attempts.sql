-- G-SEC hardening: shared, transactionally serialized platform authentication attempt gates.
-- Applied AFTER 0034. Hashes are HMAC-SHA256 with PLATFORM_JWT_SECRET in application code;
-- no raw login, IP, user ID or TOTP is stored in this table.
-- At most 5 attempts in a rolling 15-minute window per key; success resets the key.
CREATE TABLE IF NOT EXISTS platform_auth_attempt_gate (
  key_hash       TEXT PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  attempt_times  TIMESTAMPTZ[] NOT NULL DEFAULT '{}'::timestamptz[],
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (cardinality(attempt_times) <= 5)
);
CREATE INDEX IF NOT EXISTS idx_platform_auth_attempt_gate_updated
  ON platform_auth_attempt_gate(updated_at);
-- Retention: prune inactive keys at request-time (bounded batch, see PlatformAuth).
-- The table is independent of tenant identity and excluded from commercial plan changes.
