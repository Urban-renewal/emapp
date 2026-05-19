import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { pool } from '../client';
import { env } from '../env';
import * as schema from '../schema/index';

type TenantDatabase = NodePgDatabase<typeof schema>;

/**
 * The drizzle handle handed to a withTenant/withProvider callback. Exported
 * so domain services can type helper methods that receive `tx` without
 * reaching into wrapper internals.
 */
export type TenantTx = TenantDatabase;

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
    // Round trip 1 (simple protocol, no params): open the transaction and drop
    // to the restricted app_user role so RLS applies. The connecting role
    // (e.g. neondb_owner) has BYPASSRLS; app_user does not. SET LOCAL is
    // transaction-scoped — reverts on COMMIT/ROLLBACK.
    await client.query('BEGIN; SET LOCAL ROLE app_user');

    // Round trip 2 (extended protocol, parameter-bound): set all session GUCs
    // in one statement. Keys stay parameter-bound so they never appear in query
    // logs (spec §5 / §10.3). app.user_id is set ONLY when provided — leaving it
    // unset makes the notifications RLS policy compare against NULL → zero rows,
    // which is the correct safe default. Encryption key presence is guaranteed
    // by T3-env + verifyEncryptionStartup() at boot.
    if (options?.userId) {
      await client.query({
        text: 'SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)',
        values: [
          'app.organization_id',
          orgId,
          'app.encryption_key',
          env.PII_ENCRYPTION_KEY,
          'app.user_id',
          options.userId,
        ],
      });
    } else {
      await client.query({
        text: 'SELECT set_config($1, $2, true), set_config($3, $4, true)',
        values: ['app.organization_id', orgId, 'app.encryption_key', env.PII_ENCRYPTION_KEY],
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
