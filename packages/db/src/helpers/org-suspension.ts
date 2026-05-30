import { eq } from 'drizzle-orm';

import { organizations } from '../schema/tenancy';

/**
 * D.49 — is this org operationally SUSPENDED (frozen by a Provider Admin)?
 *
 * Single source of truth for the suspension gate used across the
 * enforcement points that DON'T already resolve the org in their main
 * query: tenant OTP verify (resident portal) and the share-resolution seam
 * (contractor scope). The org-tier login inlines the same predicate into
 * its auth JOIN to keep that hot path at one round-trip; every other gate
 * calls this helper so the rule lives in exactly one place.
 *
 * `executor` is a drizzle db or tx — the caller passes whichever pool /
 * context it already holds (the BYPASSRLS appPool pre-auth for OTP; the
 * `withTenant` tx for share reads). Typed `any` to accept both, matching
 * the established db/tx-seam convention in `session.repository.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function isOrgSuspended(executor: any, orgId: string): Promise<boolean> {
  const rows = (await executor
    .select({ suspendedAt: organizations.suspendedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)) as Array<{ suspendedAt: Date | null }>;
  return rows[0]?.suspendedAt != null;
}
