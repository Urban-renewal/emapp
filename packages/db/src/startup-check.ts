import { sql } from 'drizzle-orm';

import { db, providerPool } from './client';
import { env } from './env';

/**
 * P1.10 — fail-fast encryption verification, called from the API main.ts
 * AFTER boot and BEFORE serving requests.
 *
 * Verifies, against the real database + pgcrypto, that:
 *   1. pgp_sym_encrypt → pgp_sym_decrypt round-trips with PII_ENCRYPTION_KEY
 *   2. HMAC-SHA256 with PII_HASH_KEY is deterministic (same input → same output)
 *
 * If either invariant is broken (missing/incorrect keys, pgcrypto not installed),
 * this throws and the app must refuse to start. Loud failure beats silently
 * writing unrecoverable or unsearchable PII.
 */
export async function verifyEncryptionStartup(): Promise<void> {
  const probe = 'startup-encryption-probe';

  const roundTrip = await db.execute<{ decrypted: string }>(
    sql`SELECT pgp_sym_decrypt(
          pgp_sym_encrypt(${probe}, ${env.PII_ENCRYPTION_KEY}),
          ${env.PII_ENCRYPTION_KEY}
        ) AS decrypted`,
  );
  const decrypted = roundTrip.rows[0]?.decrypted;
  if (decrypted !== probe) {
    throw new Error(
      'verifyEncryptionStartup: pgcrypto round-trip failed — PII_ENCRYPTION_KEY is missing or invalid, or pgcrypto is not installed',
    );
  }

  const hmac = await db.execute<{ a: string; b: string }>(
    sql`SELECT
          encode(hmac(${probe}::bytea, ${env.PII_HASH_KEY}::bytea, 'sha256'), 'hex') AS a,
          encode(hmac(${probe}::bytea, ${env.PII_HASH_KEY}::bytea, 'sha256'), 'hex') AS b`,
  );
  const { a, b } = hmac.rows[0] ?? { a: '', b: '' };
  if (!a || a !== b) {
    throw new Error(
      'verifyEncryptionStartup: HMAC is not deterministic — PII_HASH_KEY is missing or invalid',
    );
  }
}

/**
 * **Audit v1.1 SA-1 (HIGH) closure.**
 *
 * Verifies, at boot, that the Provider pool is connected as the
 * expected DB role with BYPASSRLS — preventing the silent-fallback
 * failure where `PROVIDER_DATABASE_URL` is missing in production and
 * `client.ts` falls back to `DATABASE_URL` (app_user, no BYPASSRLS).
 * Pre-closure the symptom was a 500 on the audit INSERT (because 0009
 * REVOKE'd app_user on provider_audit_log) — loud, but the real risk
 * was a wrong-fix where ops `GRANT`ed app_user instead of setting the
 * env var, permanently destroying tier separation.
 *
 * Two assertions:
 *   1. In production, `PROVIDER_DATABASE_URL` MUST be set explicitly
 *      (no implicit fallback to DATABASE_URL).
 *   2. The role connected by the provider pool MUST be a BYPASSRLS
 *      role (typically `provider_app_role`). If the pool was wired to
 *      the wrong URL, the probe fails before serving requests.
 *
 * Skipped in test (`NODE_ENV=test`) — the test scaffold uses one DB
 * URL for both pools by design; the assertion would fire on the test
 * DB which doesn't have provider_app_role configured.
 *
 * Called from `apps/api/src/main.ts#bootstrap` alongside
 * `verifyEncryptionStartup`.
 */
export async function verifyProviderPoolRole(): Promise<void> {
  if (env.NODE_ENV === 'test') {
    // Test scaffold runs both pools against the same DB; skipping
    // matches the documented test contract.
    return;
  }
  // Assertion (1): in production, PROVIDER_DATABASE_URL must be
  // explicit. Dev is allowed to fall back (current convenience).
  if (env.NODE_ENV === 'production' && !env.PROVIDER_DATABASE_URL) {
    throw new Error(
      'verifyProviderPoolRole: PROVIDER_DATABASE_URL is required in production (Audit v1.1 SA-1). ' +
        'The Provider pool MUST connect with a dedicated BYPASSRLS role; falling back to DATABASE_URL would ' +
        'silently use app_user (no BYPASSRLS) and either crash on the audit INSERT or, if mis-fixed by GRANT, ' +
        'destroy tier separation. Set PROVIDER_DATABASE_URL to the provider_app_role connection string.',
    );
  }

  // Assertion (2): the pool actually IS BYPASSRLS. Catches the case
  // where PROVIDER_DATABASE_URL is set but wrong (points at app_user,
  // or at a role someone removed BYPASSRLS from). One round-trip on
  // the provider pool; resilient to network blips via short timeout.
  const client = await providerPool.connect();
  try {
    const res = await client.query<{
      current_user: string;
      rolbypassrls: boolean;
    }>('SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    const row = res.rows[0];
    if (!row) {
      throw new Error(
        'verifyProviderPoolRole: pg_roles returned no row for current_user — DB / driver disagreement',
      );
    }
    if (!row.rolbypassrls) {
      throw new Error(
        `verifyProviderPoolRole: provider pool connected as "${row.current_user}" which is NOT BYPASSRLS. ` +
          'Provider-tier queries would be silently RLS-filtered (returning empty results) because app.organization_id ' +
          'is not set on this pool. Check PROVIDER_DATABASE_URL — it must point at provider_app_role (or equivalent ' +
          'BYPASSRLS role), not at app_user.',
      );
    }
  } finally {
    client.release();
  }
}
