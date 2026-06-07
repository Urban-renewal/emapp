import { organizations, type TenantTx } from '@emapp/db';
import { resolveOrgSettings, DEFAULT_ORG_SETTINGS, type OrgSettings } from '@emapp/shared-types';
import { eq } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────
// getOrgSettings — THE per-org policy read seam (P1-1).
//
// Reads `organizations.settings` (jsonb) for the current org and returns a
// fully-typed `OrgSettings`, with the stored value parsed OVER the baked
// defaults. Every future per-org policy domain (notification routing,
// messaging templates, sender identity, locale/timezone, signature TTL/
// channels, consent thresholds, list/bulk limits) resolves through THIS — no
// ad-hoc per-feature config read.
//
// SOLID split: the DB resolver does ONLY the SELECT; the pure parse/merge is
// `resolveOrgSettings` in @emapp/shared-types (DB-free, unit-testable). This
// file never re-implements the merge.
//
// Fail-soft: a malformed / partial / null stored `settings`, or even a MISSING
// org row, degrades to the full default tree — a read NEVER throws on bad
// config. (`resolveOrgSettings` swallows malformed values; the missing-row
// branch returns `DEFAULT_ORG_SETTINGS`.)
//
// Runs inside the caller's `withTenant(orgId, …)` tx, so `organizations` is
// RLS-scoped to exactly this org — the `eq(id, orgId)` is belt-and-suspenders.
// One SELECT, one parse; no N+1, no re-parse loop.
// ─────────────────────────────────────────────────────────────────────────
export async function getOrgSettings(tx: TenantTx, orgId: string): Promise<OrgSettings> {
  const [row] = await tx
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Missing org row (should not happen inside a valid tenant tx) → defaults,
  // not a throw. Present row → parse the stored jsonb over the defaults.
  if (!row) return DEFAULT_ORG_SETTINGS;
  return resolveOrgSettings(row.settings);
}
