import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { pool } from '../client';
import { env } from '../env';
import * as schema from '../schema/index';

type TenantDatabase = NodePgDatabase<typeof schema>;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

/**
 * The only path to customer-facing data in the codebase.
 *
 * Sets app.organization_id (used by RLS policies) and app.encryption_key
 * (used by pgcrypto helpers) for the duration of a transaction using SET LOCAL.
 * On rollback (any throw inside fn), both contexts are discarded automatically.
 */
export async function withTenant<T>(
  orgId: string,
  fn: (tx: TenantDatabase) => Promise<T>,
  options?: { userId?: string },
): Promise<T> {
  if (!isUuid(orgId)) {
    throw new Error('withTenant: orgId must be a valid UUID');
  }
  if (options?.userId !== undefined && !isUuid(options.userId)) {
    throw new Error('withTenant: userId must be a valid UUID');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Switch to the restricted app_user role so RLS policies apply.
    // The connecting role (e.g. neondb_owner) has BYPASSRLS; app_user does not.
    // SET LOCAL is transaction-scoped — reverts to the original role on COMMIT/ROLLBACK.
    await client.query('SET LOCAL ROLE app_user');

    await client.query({
      text: 'SELECT set_config($1, $2, true)',
      values: ['app.organization_id', orgId],
    });

    // Encryption key is guaranteed present by T3-env (z.string().length(44)) and
    // verified at boot by verifyEncryptionStartup() — set unconditionally per spec §10.3.
    await client.query({
      text: 'SELECT set_config($1, $2, true)',
      values: ['app.encryption_key', env.PII_ENCRYPTION_KEY],
    });

    if (options?.userId) {
      await client.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.user_id', options.userId],
      });
    }

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
