import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerPool } from '../client';
import * as schema from '../schema/index';
import { providerAuditLog } from '../schema/provider';

type ProviderDatabase = NodePgDatabase<typeof schema>;

interface ProviderContext {
  ip?: string;
  userAgent?: string;
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

    await client.query({
      text: 'SELECT set_config($1, $2, true)',
      values: ['app.provider_user_id', providerUserId],
    });
    await client.query({
      text: 'SELECT set_config($1, $2, true)',
      values: ['app.access_reason', reason.trim()],
    });

    await client.query({
      text: `
        INSERT INTO provider_audit_log
          (provider_user_id, reason, action_type, started_at, ip, user_agent)
        VALUES
          ($1, $2, $3, $4, $5, $6)
      `,
      values: [
        providerUserId,
        reason.trim(),
        'session',
        startedAt.toISOString(),
        context?.ip ?? null,
        context?.userAgent ?? null,
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
