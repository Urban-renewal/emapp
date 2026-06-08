import { AuditService, organizations, withTenant } from '@emapp/db';
import {
  ORG_SETTINGS_NAMESPACES,
  resolveOrgSettings,
  type OrgSettings,
  type OrgSettingsNamespace,
  type OrgSettingsPatch,
} from '@emapp/shared-types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { getOrgSettings } from '../../common/org-settings.resolver';
import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/**
 * P6-1 — the admin WRITE service for the per-org settings seam.
 *
 * The seam (`organizations.settings` jsonb) is the SINGLE source of per-org
 * config; the READ resolver (`getOrgSettings`) parses it OVER defaults. This
 * service is the only write path: it validates the patch (the controller's
 * Zod pipe already did the SHAPE; the patch schema rejects unknown keys), deep-
 * merges per-namespace over the STORED jsonb (never the resolved tree — merging
 * over resolved defaults would persist every default explicitly and defeat the
 * "absent → default" contract), applies the tighten-only floor guard, persists,
 * and re-resolves so the caller always sees the fully-resolved config.
 *
 * SOLID: the merge is namespace-granular here; the parse/merge of STORED→typed
 * stays in `resolveOrgSettings` (shared-types). We never re-implement parsing.
 */
@Injectable()
export class OrgSettingsService {
  /**
   * Manager/Admin READ — the fully-RESOLVED settings (defaults + overrides), so
   * the FE always renders a complete config even for an org that overrode
   * nothing. Wrapped `{ data }` by the controller.
   */
  async get(user: AccessTokenPayload): Promise<OrgSettings> {
    return withTenant(user.orgId, (tx) => getOrgSettings(tx, user.orgId), {
      userId: user.sub,
    });
  }

  /**
   * Manager/Admin WRITE — deep-merge `patch` over the STORED settings jsonb,
   * persist, re-resolve, return the resolved tree.
   *
   * Persistence is inside ONE `withTenant(orgId, …)` tx: the SELECT (current
   * stored value), the tighten-only guard, the UPDATE, and the audit row all
   * commit atomically. RLS keeps `organizations` scoped to exactly this org —
   * the `eq(id, orgId)` is belt-and-suspenders, never a cross-org reach.
   */
  async update(user: AccessTokenPayload, patch: OrgSettingsPatch): Promise<OrgSettings> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // Current STORED jsonb (raw, NOT resolved) — the merge base. Reading
        // the raw value (not the resolved tree) preserves the "absent key →
        // default at read time" contract: we only persist what was actually
        // overridden, plus this patch.
        const [row] = await tx
          .select({ settings: organizations.settings })
          .from(organizations)
          .where(eq(organizations.id, user.orgId))
          .limit(1);
        if (!row) throw NOT_FOUND; // should not happen inside a valid tenant tx

        const stored = isPlainObject(row.settings) ? row.settings : {};

        // The RESOLVED current config — the tighten-only guard compares the
        // patch against the EFFECTIVE current values (what's actually in force),
        // not the raw stored value (which may omit a key that resolves to a
        // default floor).
        const resolvedBefore = resolveOrgSettings(stored);

        // Reject a loosening write on any security-floored namespace BEFORE we
        // merge (fail loud, persist nothing). No-op today (registry empty by
        // design — no floored knob is modeled in this open seam yet), but the
        // guard is wired so a future floored knob is enforced at the one write
        // point.
        assertTightenOnly(resolvedBefore, patch);

        const { merged, changed } = deepMergeNamespaces(stored, patch);

        await tx
          .update(organizations)
          .set({ settings: merged })
          .where(eq(organizations.id, user.orgId));

        // Audit — NAMES ONLY. A settings namespace can hold an org's sender
        // identity / from-address; the changed VALUES are never written to the
        // (org-readable) audit log. The touched namespace KEYS are enough to
        // answer "who changed settings, when, which area" without leaking the
        // new values.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'org.settings.update',
          targetTable: 'organizations',
          targetId: user.orgId,
          afterState: { changed }, // namespace key names only — no values
          sessionId: user.sid,
        });

        // Re-resolve the just-persisted value so the response is the canonical
        // fully-defaulted tree (same shape GET returns).
        return resolveOrgSettings(merged);
      },
      { userId: user.sub },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Deep-merge — per-NAMESPACE, one level of object spread. A namespace present
// in the patch is shallow-merged onto its stored counterpart (so untouched
// LEAVES in that namespace survive); a namespace ABSENT from the patch is left
// exactly as stored (never clobbered). Leaf scalars/arrays in a patched
// namespace REPLACE the stored leaf (an array override is wholesale by design —
// `defaultChannels:[…]` sets the new list, it does not concatenate).
//
// Granularity matches the read seam (`resolveOrgSettings` is per-namespace):
// the FE PATCHes a namespace's full object for the leaves it changes, and we
// merge namespace-onto-namespace so a sibling namespace is preserved.
// ─────────────────────────────────────────────────────────────────────────
function deepMergeNamespaces(
  stored: Record<string, unknown>,
  patch: OrgSettingsPatch,
): { merged: Record<string, unknown>; changed: OrgSettingsNamespace[] } {
  const merged: Record<string, unknown> = { ...stored };
  const changed: OrgSettingsNamespace[] = [];

  for (const ns of ORG_SETTINGS_NAMESPACES) {
    const patchVal = (patch as Record<string, unknown>)[ns];
    if (patchVal === undefined) continue; // namespace not in the patch → untouched
    changed.push(ns);
    if (isPlainObject(patchVal)) {
      const storedNs = isPlainObject(stored[ns]) ? (stored[ns] as Record<string, unknown>) : {};
      merged[ns] = { ...storedNs, ...patchVal };
    } else {
      // Scalar namespace (locale / timezone) — replace wholesale.
      merged[ns] = patchVal;
    }
  }
  return { merged, changed };
}

/**
 * SECURITY-FLOOR tighten-only guard (the spec's "SECURITY FLOOR" — see
 * `org-settings.ts`). A namespace listed here may only be TIGHTENED by a PATCH,
 * never loosened: a write that would weaken a locked invariant is rejected
 * (BadRequest), not clamped silently.
 *
 * EMPTY BY DESIGN today: every modeled namespace is a free PREFERENCE
 * (notifications channels, sender identity, locale/timezone, signature
 * delivery, consent defaults, ergonomics limits). The genuinely security-
 * sensitive knobs (OTP/lockout/throttle, token TTLs) are deliberately NOT in
 * this open seam (they are LOCKED / tighten-only and enforced elsewhere in
 * Phase 6), so there is nothing to clamp here. The registry + guard are wired
 * NOW so the day a floored knob is added to the seam, its tighten-only rule has
 * exactly one enforcement point — no new write path to audit.
 *
 * A future entry would look like:
 *   signatures: (before, after) => after.linkTtlDays <= before.linkTtlDays
 * (a shorter link TTL is tighter; a longer one would be the loosening to reject).
 */
type FloorCheck = (before: OrgSettings, patched: OrgSettings) => boolean;
const TIGHTEN_ONLY: Partial<Record<OrgSettingsNamespace, FloorCheck>> = {
  // intentionally empty — see JSDoc above.
};

function assertTightenOnly(before: OrgSettings, patch: OrgSettingsPatch): void {
  const entries = Object.entries(TIGHTEN_ONLY) as Array<[OrgSettingsNamespace, FloorCheck]>;
  if (entries.length === 0) return; // fast path — no floored namespace today
  // Resolve the would-be result so a check compares fully-typed before/after.
  const patched = resolveOrgSettings({ ...before, ...patch });
  for (const [ns, check] of entries) {
    if ((patch as Record<string, unknown>)[ns] === undefined) continue; // untouched
    if (!check(before, patched)) {
      throw new BadRequestException({
        error: { code: 'org_settings_floor_violation', message: `cannot loosen ${ns}` },
      });
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
