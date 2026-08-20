-- IR-05: unique login per tenant (compound), removing the global UNIQUE.
--
-- Model decision (documented in README): in v1 an internal account belongs to
-- exactly one tenant (seed is 1:1 at this point). We add internal_user.tenant_id,
-- backfill it from the single-tenant activations in user_role, enforce NOT NULL,
-- drop the global login UNIQUE and create a compound unique index on
-- (lower(login), tenant_id).

-- 1. Add the tenant column (nullable for the backfill phase).
ALTER TABLE internal_user ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES client(client_id);

-- 2. Backfill from existing single-tenant activations.
UPDATE internal_user u
   SET tenant_id = sub.tenant_id
  FROM (SELECT user_id, MIN(tenant_id) AS tenant_id
          FROM user_role
         GROUP BY user_id
        HAVING count(DISTINCT tenant_id) = 1) sub
 WHERE u.user_id = sub.user_id
   AND u.tenant_id IS NULL;

-- 3. Fail loudly if a user cannot be assigned to one tenant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM internal_user WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION
      'Cannot migrate: internal_user has rows without a single tenant activation (first: %)',
      (SELECT user_id FROM internal_user WHERE tenant_id IS NULL ORDER BY user_id LIMIT 1);
  END IF;
END $$;

-- 4. Enforce the new invariant and the compound uniqueness.
ALTER TABLE internal_user ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE internal_user DROP CONSTRAINT IF EXISTS internal_user_login_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_user_login_tenant
  ON internal_user (lower(login), tenant_id);
