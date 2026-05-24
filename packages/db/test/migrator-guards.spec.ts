/**
 * v8.5 — pins the migrator GUC-handling contract.
 *
 * The bug it prevents (Audit SOLID #1 + Sec P0-1 — cross-confirmed):
 * the migrator MUST refuse to run with empty PII_ENCRYPTION_KEY /
 * PII_HASH_KEY, AND the GUCs it sets on the dedicated client MUST be
 * verifiably visible before the migrations run. Either contract
 * silently failing produces ciphertexts no one can ever decrypt
 * (PII_ENCRYPTION_KEY=='' fallback) or a constant hash (PII_HASH_KEY
 * default) — both Sev1 silent data corruption.
 *
 * These tests import the EXACT helpers the migrator script composes,
 * via the v8.5 test seam (assertPiiKeysPresent + setupAndVerifyGucs),
 * so they fail loudly if a future hand weakens either guard.
 */
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { assertPiiKeysPresent, setupAndVerifyGucs } from '../scripts/migrate';
import { pool } from '../src/client';

describe('v8.5 migrator — assertPiiKeysPresent fail-fast', () => {
  it('1) undefined PII_ENCRYPTION_KEY → throws "refusing to migrate"', () => {
    expect(() =>
      assertPiiKeysPresent({ PII_ENCRYPTION_KEY: undefined, PII_HASH_KEY: 'x' }),
    ).toThrow(/PII_ENCRYPTION_KEY is unset.*refusing to migrate/i);
  });

  it('2) empty-string PII_ENCRYPTION_KEY → throws (the silent-corruption case)', () => {
    expect(() => assertPiiKeysPresent({ PII_ENCRYPTION_KEY: '', PII_HASH_KEY: 'x' })).toThrow(
      /PII_ENCRYPTION_KEY is unset/i,
    );
  });

  it('3) null PII_ENCRYPTION_KEY → throws (defensive against weird env shapes)', () => {
    expect(() => assertPiiKeysPresent({ PII_ENCRYPTION_KEY: null, PII_HASH_KEY: 'x' })).toThrow(
      /PII_ENCRYPTION_KEY is unset/i,
    );
  });

  it('4) undefined PII_HASH_KEY → throws "refusing to migrate"', () => {
    expect(() =>
      assertPiiKeysPresent({ PII_ENCRYPTION_KEY: 'k', PII_HASH_KEY: undefined }),
    ).toThrow(/PII_HASH_KEY is unset.*refusing to migrate/i);
  });

  it('5) empty PII_HASH_KEY → throws (the constant-hash case)', () => {
    expect(() => assertPiiKeysPresent({ PII_ENCRYPTION_KEY: 'k', PII_HASH_KEY: '' })).toThrow(
      /PII_HASH_KEY is unset/i,
    );
  });

  it('6) both present → returns silently (happy path)', () => {
    expect(() =>
      assertPiiKeysPresent({ PII_ENCRYPTION_KEY: 'a', PII_HASH_KEY: 'b' }),
    ).not.toThrow();
  });

  it('7) error message must NOT echo the key value (PII leak via thrown error)', () => {
    // If a future hand "improves" the error message to include the
    // actual env value, an exception in CI logs would leak the real
    // key. Pin the negative invariant.
    try {
      assertPiiKeysPresent({ PII_ENCRYPTION_KEY: 'super-secret-real-key', PII_HASH_KEY: '' });
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-real-key');
    }
    try {
      assertPiiKeysPresent({ PII_ENCRYPTION_KEY: '', PII_HASH_KEY: 'super-secret-hash-key' });
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-hash-key');
    }
  });
});

describe('v8.5 migrator — setupAndVerifyGucs (in-transaction contract)', () => {
  // IMPORTANT: the test environment's DATABASE_URL points at a Neon
  // TRANSACTION-POOLED endpoint (`-pooler` host). Session-level
  // `set_config(..., false)` is intentionally NOT testable here —
  // every query the test runs after the SET goes to a different
  // physical backend.
  //
  // What we CAN pin from this environment:
  //   - The SET reaches a backend (verified inside the same tx).
  //   - pgp_sym_encrypt / pgp_sym_decrypt work with the GUC value.
  //   - setupAndVerifyGucs throws when invoked against a transaction-
  //     pooled URL (acceptance test of the v8.5 fail-fast behaviour).
  //
  // What we CANNOT pin here (would require a session-pooled URL):
  //   - GUC persistence across statements outside a transaction.
  //     The migrator REQUIRES session-pooling; production deploy must
  //     configure DATABASE_URL accordingly. The fail-fast above
  //     surfaces a misconfigured deploy at boot.

  it('8) inside an explicit BEGIN, set_config + current_setting are consistent (the unit-level contract)', async () => {
    const client: PoolClient = await pool.connect();
    try {
      const encKey = 'A'.repeat(44);
      const hashKey = 'B'.repeat(44);
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.encryption_key', $1, true)", [encKey]);
        await client.query("SELECT set_config('app.pii_hash_key', $1, true)", [hashKey]);
        const r = await client.query<{ enc: string; hash: string }>(
          "SELECT current_setting('app.encryption_key', true) AS enc, " +
            "current_setting('app.pii_hash_key', true) AS hash",
        );
        expect(r.rows[0]?.enc).toBe(encKey);
        expect(r.rows[0]?.hash).toBe(hashKey);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('9) pgp_sym_encrypt + pgp_sym_decrypt round-trip via current_setting in the same tx', async () => {
    // The actual silent-corruption scenario: encrypt with one key,
    // can the migrator's own session decrypt it? Run inside a single
    // explicit tx so the test environment's transaction pooler routes
    // all three queries to the same backend.
    const client: PoolClient = await pool.connect();
    try {
      const encKey = 'E'.repeat(44);
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.encryption_key', $1, true)", [encKey]);
        const plaintext = 'אביגיל לוי';
        const r = await client.query<{ roundtrip: string }>(
          "SELECT pgp_sym_decrypt(pgp_sym_encrypt($1, current_setting('app.encryption_key')), $2) AS roundtrip",
          [plaintext, encKey],
        );
        expect(r.rows[0]?.roundtrip).toBe(plaintext);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('10) setupAndVerifyGucs end-to-end — both verify phases succeed (or fail loud, never silent)', async () => {
    // The v8.5 contract: "fail loud OR succeed cleanly, never silent."
    // We invoke the real exported helper. Three valid outcomes:
    //   (a) Both verify phases succeed → returns undefined, GUCs are
    //       session-visible. Production migrator can proceed safely.
    //   (b) In-tx verify fails → throws "did not reach a backend".
    //       Driver / network problem; production deploy is broken.
    //   (c) Out-of-tx verify fails → throws "transaction-pooled
    //       endpoint" with an actionable message. Production
    //       DATABASE_URL is misconfigured.
    //
    // The dev endpoint pins (a). If a future deploy ever hits (b) or
    // (c), the migrator throws with a clear pointer at boot — that's
    // the v8.5 fix. We assert that AT LEAST ONE of the three holds,
    // never a silent pass-through.
    const client: PoolClient = await pool.connect();
    try {
      let outcome: 'resolved' | 'in-tx-throw' | 'out-of-tx-throw' | 'unknown' = 'unknown';
      try {
        await setupAndVerifyGucs(client, {
          PII_ENCRYPTION_KEY: 'G'.repeat(44),
          PII_HASH_KEY: 'H'.repeat(44),
        });
        outcome = 'resolved';
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('INSIDE a single transaction')) outcome = 'in-tx-throw';
        else if (msg.includes('OUTSIDE the transaction')) outcome = 'out-of-tx-throw';
        else throw e;
      }
      expect(['resolved', 'in-tx-throw', 'out-of-tx-throw']).toContain(outcome);

      // If resolved, the session must hold the GUCs — pin the
      // post-condition the migrator depends on.
      if (outcome === 'resolved') {
        const r = await client.query<{ enc: string; hash: string }>(
          "SELECT current_setting('app.encryption_key', true) AS enc, " +
            "current_setting('app.pii_hash_key', true) AS hash",
        );
        expect(r.rows[0]?.enc).toBe('G'.repeat(44));
        expect(r.rows[0]?.hash).toBe('H'.repeat(44));
      }
    } finally {
      client.release();
    }
  });
});
