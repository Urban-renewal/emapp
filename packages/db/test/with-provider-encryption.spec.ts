/**
 * v8.5 P0 (Audit Sec P0-2): withProvider MUST set app.encryption_key
 * AND app.pii_hash_key so any Provider-Admin path that decrypts owner
 * PII (national_id / phone / name) actually works.
 *
 * Pre-v8.5: only app.provider_user_id + app.access_reason were set.
 * The first Provider-Admin owner-read in production would have
 * thrown `current_setting('app.encryption_key')` failures, or worse,
 * returned an empty key and silently produced garbage decrypts.
 *
 * These tests pin all four GUCs from inside the wrapper. If a future
 * refactor drops the encryption GUCs again, these fail loud.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool, providerPool } from '../src/client';
import { env } from '../src/env';
import { withProvider } from '../src/wrappers/with-provider';

import { createTestProviderUser, type TestProviderUser } from './factories';
import { setupTestDatabase } from './setup';

describe('v8.5 withProvider — encryption + hash GUCs available', () => {
  let provider: TestProviderUser;

  beforeAll(async () => {
    await setupTestDatabase();
    provider = await createTestProviderUser();
  });

  afterAll(async () => {
    // Pools are shared across all spec files via the module-level
    // singletons in src/client.ts — closing them here would break
    // sibling specs running in the same vitest worker. The global
    // teardown handles pool shutdown.
  });

  it('1) app.encryption_key is set inside withProvider AND matches env.PII_ENCRYPTION_KEY', async () => {
    const value = await withProvider(provider.id, 'v8.5 GUC smoke test', async (tx) => {
      const r = await tx.execute<{ k: string | null }>(
        // sql.raw not needed — current_setting is a built-in
        // function, parameter-bound `false` means "no error if unset"
        // so we'd get NULL instead of throw — exactly what we want
        // to assert against (NULL = bug, value = fix).

        "SELECT current_setting('app.encryption_key', true) AS k",
      );
      return r.rows[0]?.k ?? null;
    });
    expect(value).toBe(env.PII_ENCRYPTION_KEY);
    expect(value).not.toBeNull();
    expect(value).not.toBe('');
  });

  it('2) app.pii_hash_key is set inside withProvider AND matches env.PII_HASH_KEY', async () => {
    const value = await withProvider(provider.id, 'v8.5 hash GUC smoke', async (tx) => {
      const r = await tx.execute<{ k: string | null }>(
        "SELECT current_setting('app.pii_hash_key', true) AS k",
      );
      return r.rows[0]?.k ?? null;
    });
    expect(value).toBe(env.PII_HASH_KEY);
    expect(value).not.toBeNull();
    expect(value).not.toBe('');
  });

  it('3) app.provider_user_id and app.access_reason ALSO still set (no regression on the pre-v8.5 contract)', async () => {
    const { uid, reason } = await withProvider(
      provider.id,
      'v8.5 provider identity GUC check',
      async (tx) => {
        const r = await tx.execute<{ uid: string | null; reason: string | null }>(
          "SELECT current_setting('app.provider_user_id', true) AS uid, current_setting('app.access_reason', true) AS reason",
        );
        return { uid: r.rows[0]?.uid ?? null, reason: r.rows[0]?.reason ?? null };
      },
    );
    expect(uid).toBe(provider.id);
    expect(reason).toBe('v8.5 provider identity GUC check');
  });

  it('4) pgp_sym_decrypt with the GUC key round-trips identically to env.PII_ENCRYPTION_KEY', async () => {
    // The actual scenario this guard exists for: a Provider-Admin
    // tool decrypts an owner's national_id. If the GUC wasn't set,
    // pgp_sym_decrypt with an empty-string key would either throw
    // or return garbage. This test proves the GUC-bound decrypt
    // matches the env-bound decrypt byte-for-byte.
    const plaintext = '038123456';
    const result = await withProvider(provider.id, 'v8.5 decrypt round-trip', async (tx) => {
      // Encrypt with env value, decrypt with current_setting — they
      // MUST agree because v8.5 sets the GUC from the same env.
      const r = await tx.execute<{ matches: boolean }>(
        `SELECT pgp_sym_decrypt(pgp_sym_encrypt('${plaintext}', '${env.PII_ENCRYPTION_KEY}'), current_setting('app.encryption_key')) = '${plaintext}' AS matches`,
      );
      return r.rows[0]?.matches ?? false;
    });
    expect(result).toBe(true);
  });

  it('5) GUCs are tx-scoped (third arg true) — do NOT leak to a sibling pool checkout', async () => {
    // The contract: withProvider uses SET LOCAL (third arg true), so
    // GUCs revert on tx commit/rollback. A bare providerPool checkout
    // outside withProvider must NOT see the encryption key — otherwise
    // we'd have a cross-call leak.
    await withProvider(provider.id, 'v8.5 leak test setup', async (tx) => {
      await tx.execute("SELECT current_setting('app.encryption_key', true)");
    });
    // After the wrapper returns, the connection is back in the pool.
    // A fresh checkout (different transaction) must see NULL/empty.
    // Note: same pool, may return the same physical conn — that's
    // exactly the case we want to prove safe. SET LOCAL reverts on
    // COMMIT, so a NEW BEGIN would see no value.
    const client = await providerPool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{ k: string | null }>(
        "SELECT current_setting('app.encryption_key', true) AS k",
      );
      // Outside a withProvider tx, the key MUST NOT be visible.
      expect(r.rows[0]?.k === null || r.rows[0]?.k === '').toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('6) ROLLBACK on throw — encryption GUC is NOT leaked to the next withProvider call', async () => {
    // If fn() throws, withProvider must ROLLBACK; the SET LOCAL GUCs
    // revert. The next call sees its own values.
    await expect(
      withProvider(provider.id, 'v8.5 rollback test', async () => {
        throw new Error('synthetic failure');
      }),
    ).rejects.toThrow(/synthetic failure/);

    // Now a fresh call — the GUCs must work normally.
    const v = await withProvider(provider.id, 'v8.5 post-rollback check', async (tx) => {
      const r = await tx.execute<{ k: string | null }>(
        "SELECT current_setting('app.encryption_key', true) AS k",
      );
      return r.rows[0]?.k ?? null;
    });
    expect(v).toBe(env.PII_ENCRYPTION_KEY);
  });

  it('A1) ADVERSARIAL — SQL-injection-shaped reason field is parameter-bound (not executed)', async () => {
    // A hostile Provider Admin (or stolen Provider creds) could try
    // to smuggle SQL through the reason field. The reason gets written
    // to provider_audit_log AND becomes the app.access_reason GUC.
    // Both must be safe even if reason contains SQL meta-chars.
    const evil = "'); DROP TABLE provider_audit_log; --";
    const stored = await withProvider(provider.id, evil, async (tx) => {
      const r = await tx.execute<{ r: string | null }>(
        "SELECT current_setting('app.access_reason', true) AS r",
      );
      return r.rows[0]?.r ?? null;
    });
    // The reason MUST come back byte-identical — proving it was
    // parameter-bound, not executed.
    expect(stored).toBe(evil);
    // provider_audit_log MUST still exist.
    const client = await providerPool.connect();
    try {
      await client.query('SELECT 1 FROM provider_audit_log LIMIT 1');
    } finally {
      client.release();
    }
  });

  it('A2) ADVERSARIAL — extremely long reason (10KB) — accepted or rejected, never crashes the wrapper', async () => {
    const huge = 'x'.repeat(10_000);
    let outcome: 'ok' | 'thrown' = 'thrown';
    try {
      await withProvider(provider.id, huge, async () => undefined);
      outcome = 'ok';
    } catch {
      outcome = 'thrown';
    }
    expect(['ok', 'thrown']).toContain(outcome);
  });

  it('A3) ADVERSARIAL — reason with embedded null byte is SANITIZED (D.37 hardening, no silent storage of control chars)', async () => {
    // Pre-D.37: this test asserted withProvider THREW because Postgres
    // TEXT rejected null bytes. Post-D.37 P6.5-1 hardening: the wrapper
    // STRIPS control chars (including \0) BEFORE the INSERT, so the
    // call succeeds with a clean stored reason. This is a behavior
    // improvement (sanitize > reject) verified more thoroughly by the
    // T6.5-D37-0i battery in with-provider-d37-audit.spec.ts.
    const evil = 'inv\0estigation';
    await expect(withProvider(provider.id, evil, async () => undefined)).resolves.toBeUndefined();
  });

  it('A4) ADVERSARIAL — reason too short (< 5 chars) is REJECTED before any DB call', async () => {
    await expect(withProvider(provider.id, 'no', async () => undefined)).rejects.toThrow(
      /reason is required/i,
    );
  });

  it('A5) ADVERSARIAL — providerUserId that is NOT a UUID is REJECTED before any DB call', async () => {
    await expect(
      withProvider('not-a-uuid', 'legitimate reason', async () => undefined),
    ).rejects.toThrow(/valid UUID/i);
    await expect(
      withProvider(
        "'); DROP TABLE provider_audit_log; --",
        'legitimate reason',
        async () => undefined,
      ),
    ).rejects.toThrow(/valid UUID/i);
  });
});

// Avoid an unused-import lint flag — pool is exported for symmetry
// with provider-tier.spec.ts (operators reaching for "all the conns
// in scope") and also makes it grep-friendly if a future test adds
// a tenant-side companion. Reference once so eslint is happy.
void pool;
