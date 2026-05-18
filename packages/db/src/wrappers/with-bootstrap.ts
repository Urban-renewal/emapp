import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerPool } from '../client';
import * as schema from '../schema/index';

type BootstrapDatabase = NodePgDatabase<typeof schema>;

/**
 * The ONLY sanctioned RLS-bypass for self-serve first-org signup (D.21).
 *
 * Why a bypass is unavoidable: the `users` RLS policy (Template C) requires a
 * membership row to already exist, and `organizations` RLS requires
 * `app.organization_id` to be set — neither can hold during the very first
 * org+user+membership insert (chicken-and-egg). Doc 08 §5 mandates this be
 * ONE atomic transaction.
 *
 * Safety boundary: every id written by the caller MUST be server-generated
 * (randomUUID), never client-controlled; the only client strings allowed are
 * plain text values (org name, user name, email) bound as parameters. The
 * caller MUST write the org_created / first_manager audit rows INSIDE `fn`
 * (same tx) so the privileged write is always audited. This wrapper is the
 * single named primitive that may touch the BYPASSRLS pool from a public
 * path — `providerDb` must never be referenced raw from app/controller code.
 */
export async function withBootstrap<T>(fn: (tx: BootstrapDatabase) => Promise<T>): Promise<T> {
  const client = await providerPool.connect();
  try {
    await client.query('BEGIN');
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
