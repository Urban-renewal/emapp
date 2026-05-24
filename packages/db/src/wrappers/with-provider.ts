import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerPool } from '../client';
import { env } from '../env';
import * as schema from '../schema/index';
import { providerAuditLog } from '../schema/provider';

type ProviderDatabase = NodePgDatabase<typeof schema>;

interface ProviderContext {
  ip?: string;
  userAgent?: string;
  targetTable?: string;
  targetRecordId?: string;
  /**
   * D.37 / Phase 6.5 — explicit action label for the audit row.
   * Defaults to `'session'` (back-compat for pre-D.37 callers).
   * Phase 6.5 endpoints pass their specific action
   * (`'provider.tenant.viewed'` / `'provider.audit.searched'` /
   * `'provider.health.read'`).
   */
  action?: string;
  /**
   * D.37 — additional structured metadata merged INTO
   * `provider_audit_log.metadata` (the JSONB column). The wrapper
   * ALWAYS overlays `{ reason }` on top so queries against
   * `metadata.reason` work uniformly; caller-supplied keys with the
   * literal name `reason` are intentionally overwritten (no way for
   * a caller to spoof a different reason in metadata than the one
   * recorded in the dedicated `reason` column).
   */
  metadata?: Record<string, unknown>;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

/**
 * The path for Provider tier (EMAPP team) access to customer data.
 *
 * Uses the provider_app_role pool (BYPASSRLS — can query across tenants).
 * EVERY call writes a provider_audit_log entry BEFORE the work runs.
 * Both the audit entry and the work are in the same transaction:
 * if the work fails, the audit row is rolled back too (but the failed
 * attempt is captured by the caller's error handler / Sentry).
 */
export async function withProvider<T>(
  providerUserId: string,
  reason: string,
  fn: (tx: ProviderDatabase) => Promise<T>,
  context?: ProviderContext,
): Promise<T> {
  if (!isUuid(providerUserId)) {
    throw new Error('withProvider: providerUserId must be a valid UUID');
  }
  if (!reason || reason.trim().length < 5) {
    throw new Error('withProvider: reason is required (minimum 5 chars)');
  }

  const client = await providerPool.connect();
  const startedAt = new Date();

  try {
    await client.query('BEGIN');

    // All four session GUCs in one round trip (parameter-bound).
    //
    // v8.5 P0 FIX (Audit Sec P0-2): pre-v8.5 only the two provider-
    // identity GUCs were set. app.encryption_key + app.pii_hash_key
    // were silently absent, so the moment ANY Provider Admin code
    // path read a pgcrypto-decrypted column (e.g. owners.national_id
    // for a customer-data audit) `current_setting('app.encryption_key')`
    // would throw `unrecognized configuration parameter` OR — worse,
    // depending on PostgreSQL config — return an empty string and the
    // decrypt would silently yield garbage. Mirrors withTenant's
    // contract; the same env.PII_ENCRYPTION_KEY is enforced at boot
    // by verifyEncryptionStartup().
    await client.query({
      text:
        'SELECT set_config($1, $2, true), set_config($3, $4, true), ' +
        'set_config($5, $6, true), set_config($7, $8, true)',
      values: [
        'app.provider_user_id',
        providerUserId,
        'app.access_reason',
        reason.trim(),
        'app.encryption_key',
        env.PII_ENCRYPTION_KEY,
        'app.pii_hash_key',
        env.PII_HASH_KEY,
      ],
    });

    // D.37 / Phase 6.5 fix (foundational invariant T6.5-D37-0):
    // populate `metadata.reason` in addition to the dedicated `reason`
    // column. Pre-Phase-6.5 the metadata jsonb was always `{}`; every
    // search/filter pattern in the rest of the codebase queries via
    // `metadata.<field>` so requiring callers to pivot through the
    // top-level reason column would be a special-case in audit search.
    // Caller-supplied metadata keys are merged in BENEATH the reason
    // overlay — a caller cannot smuggle a fake `reason` into metadata.
    const metadataPayload: Record<string, unknown> = {
      ...(context?.metadata ?? {}),
      reason: reason.trim(),
    };
    const actionType = context?.action ?? 'session';

    await client.query({
      text: `
        INSERT INTO provider_audit_log
          (provider_user_id, reason, action_type, started_at, ip, user_agent,
           target_table, target_record_id, metadata)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      values: [
        providerUserId,
        reason.trim(),
        actionType,
        startedAt.toISOString(),
        context?.ip ?? null,
        context?.userAgent ?? null,
        context?.targetTable ?? null,
        context?.targetRecordId ?? null,
        JSON.stringify(metadataPayload),
      ],
    });

    const tx = drizzle(client, { schema });
    const result = await fn(tx);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

void providerAuditLog; // imported to validate schema reference
