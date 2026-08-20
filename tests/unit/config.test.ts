import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/shared/config.ts';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('IR-02 unit: JWT_SECRET is required in development (no default secret)', () => {
  withEnv({ APP_ENV: 'development', JWT_SECRET: undefined }, () => {
    assert.throws(() => loadConfig(), /JWT_SECRET is required/);
  });
  withEnv({ APP_ENV: 'production', JWT_SECRET: undefined }, () => {
    assert.throws(() => loadConfig(), /JWT_SECRET is required/);
  });
});

test('IR-02 unit: known placeholder secrets are rejected', () => {
  withEnv({ APP_ENV: 'development', JWT_SECRET: 'cambiar_antes_de_usar' }, () => {
    assert.throws(() => loadConfig(), /must not be a placeholder/);
  });
  withEnv({ APP_ENV: 'development', JWT_SECRET: 'mainspot-dev-only-secret-change-me' }, () => {
    assert.throws(() => loadConfig(), /must not be a placeholder/);
  });
});

test('IR-02 unit: real secret accepted; test env may run without one', () => {
  withEnv({ APP_ENV: 'development', JWT_SECRET: '0123456789abcdef0123456789abcdef' }, () => {
    assert.equal(loadConfig().jwtSecret, '0123456789abcdef0123456789abcdef');
  });
  withEnv({ APP_ENV: 'test', JWT_SECRET: undefined }, () => {
    assert.doesNotThrow(() => loadConfig());
  });
});

test('IR-10 unit: invalid enums fail fast with the allowed values listed', () => {
  withEnv(
    { APP_ENV: 'test', JWT_SECRET: 'test-secret', AUDIT_MODE: 'sometimes' },
    () => {
      assert.throws(() => loadConfig(), /AUDIT_MODE=sometimes\. Allowed values: fail_closed, fail_open/);
    },
  );
  withEnv(
    { APP_ENV: 'test', JWT_SECRET: 'test-secret', LOG_LEVEL: 'chatty' },
    () => {
      assert.throws(() => loadConfig(), /LOG_LEVEL=chatty\. Allowed values: debug, info, warn, error/);
    },
  );
  withEnv({ APP_ENV: 'banana', JWT_SECRET: 'test-secret' }, () => {
    assert.throws(() => loadConfig(), /APP_ENV=banana\. Allowed values: development, production, test/);
  });
});

test('IR-10 unit: valid enums are accepted', () => {
  withEnv(
    { APP_ENV: 'test', JWT_SECRET: 'test-secret', AUDIT_MODE: 'fail_open', LOG_LEVEL: 'debug' },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.auditMode, 'fail_open');
      assert.equal(cfg.logLevel, 'debug');
    },
  );
});
