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

// --- APR-0002: JEV_* (Jev como clasificador: disabled | shadow | primary) ----

const FAKE_KEY = 'ts-fake-key-0123456789abcdef';
const JEV_UNSET = {
  APP_ENV: 'test',
  JWT_SECRET: 'test-secret',
  JEV_ENABLED: undefined,
  JEV_SHADOW_MODE: undefined,
  JEV_MODE: undefined,
  JEV_PROVIDER: undefined,
  TYPESAFE_API_KEY: undefined,
  JEV_MODEL: undefined,
  JEV_DATA_SCOPE: undefined,
  JEV_SYNTHETIC_TENANTS: undefined,
  JEV_DAILY_BUDGET_USD: undefined,
};
const JEV_ON = { JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: FAKE_KEY, JEV_SYNTHETIC_TENANTS: 'client_a' };

function jevThrows(env: Record<string, string | undefined>, pattern: RegExp): void {
  withEnv({ ...JEV_UNSET, ...env }, () => {
    assert.throws(
      () => loadConfig(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, pattern);
        assert.ok(!err.message.includes(FAKE_KEY), 'the key never appears in config errors');
        return true;
      },
    );
  });
}

test('APR-0002 unit: Jev is disabled by default and disabled needs no key', () => {
  withEnv(JEV_UNSET, () => {
    assert.deepEqual(loadConfig().jev, { mode: 'disabled' });
  });
  withEnv({ ...JEV_UNSET, JEV_MODE: 'disabled', TYPESAFE_API_KEY: FAKE_KEY }, () => {
    assert.deepEqual(loadConfig().jev, { mode: 'disabled' });
  });
});

test('APR-0002 unit: shadow and primary configs are accepted with synthetic scope and default budget', () => {
  for (const mode of ['shadow', 'primary'] as const) {
    withEnv(
      { ...JEV_UNSET, ...JEV_ON, JEV_MODE: mode, TYPESAFE_API_KEY: ` ${FAKE_KEY} `, JEV_MODEL: 'jev-latest', JEV_SYNTHETIC_TENANTS: ' client_a, client_b ,client_a,' },
      () => {
        assert.deepEqual(loadConfig().jev, {
          mode, provider: 'typesafe', apiKey: FAKE_KEY, model: 'jev-latest', dataScope: 'synthetic',
          syntheticTenants: ['client_a', 'client_b'], dailyBudgetUsd: 1,
        });
      },
    );
  }
  withEnv({ ...JEV_UNSET, ...JEV_ON, JEV_MODE: 'shadow', JEV_DAILY_BUDGET_USD: '0.25' }, () => {
    const jev = loadConfig().jev;
    assert.ok(jev.mode === 'shadow');
    assert.equal(jev.model, null, 'blank JEV_MODEL ⇒ provider alias');
    assert.equal(jev.dailyBudgetUsd, 0.25);
  });
});

test('APR-0002 unit: the replaced JEV_ENABLED / JEV_SHADOW_MODE variables abort startup', () => {
  jevThrows({ JEV_ENABLED: 'false' }, /JEV_ENABLED no longer exist: use JEV_MODE=disabled\|shadow\|primary/);
  jevThrows({ JEV_SHADOW_MODE: 'true', JEV_MODE: 'shadow', ...JEV_ON }, /JEV_SHADOW_MODE no longer exist/);
  jevThrows({ JEV_ENABLED: '', JEV_SHADOW_MODE: '' }, /JEV_ENABLED and JEV_SHADOW_MODE no longer exist/);
});

test('APR-0002 unit: enabled modes without key, provider or synthetic tenants fail fast', () => {
  jevThrows({ ...JEV_ON, JEV_MODE: 'shadow', TYPESAFE_API_KEY: undefined }, /TYPESAFE_API_KEY is required when JEV_MODE=shadow/);
  jevThrows({ ...JEV_ON, JEV_MODE: 'primary', TYPESAFE_API_KEY: '   ' }, /TYPESAFE_API_KEY is required when JEV_MODE=primary/);
  jevThrows({ ...JEV_ON, JEV_MODE: 'shadow', JEV_PROVIDER: undefined }, /JEV_PROVIDER is required when JEV_MODE=shadow/);
  jevThrows({ ...JEV_ON, JEV_MODE: 'primary', JEV_SYNTHETIC_TENANTS: ' , ' }, /JEV_SYNTHETIC_TENANTS is required when JEV_MODE=primary/);
});

test('APR-0002 unit: only typesafe, synthetic scope and known modes are accepted', () => {
  jevThrows({ ...JEV_ON, JEV_MODE: 'shadow', JEV_PROVIDER: 'openrouter' }, /JEV_PROVIDER=openrouter\. Allowed values: typesafe/);
  jevThrows({ JEV_PROVIDER: 'mock' }, /JEV_PROVIDER=mock\. Allowed values: typesafe/);
  jevThrows({ ...JEV_ON, JEV_MODE: 'shadow', JEV_DATA_SCOPE: 'real' }, /JEV_DATA_SCOPE=real\. Allowed values: synthetic/);
  jevThrows({ JEV_MODE: 'authoritative' }, /JEV_MODE=authoritative\. Allowed values: disabled, shadow, primary/);
});

test('DEC-0032 unit: the daily budget must be positive and at most USD 1', () => {
  for (const bad of ['0', '-1', '1.01', 'abc', 'Infinity']) {
    jevThrows({ ...JEV_ON, JEV_MODE: 'shadow', JEV_DAILY_BUDGET_USD: bad }, /JEV_DAILY_BUDGET_USD=.*at most 1 \(DEC-0032\)/);
  }
  withEnv({ ...JEV_UNSET, ...JEV_ON, JEV_MODE: 'shadow', JEV_DAILY_BUDGET_USD: '1' }, () => {
    const jev = loadConfig().jev;
    assert.equal(jev.mode !== 'disabled' && jev.dailyBudgetUsd, 1);
  });
});
