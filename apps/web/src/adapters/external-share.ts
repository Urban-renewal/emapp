/**
 * Wire → ViewModel adapter + FE-safe preset-ceiling mirror for the external-
 * share ("invite a party") surface — V13 X-S6/X-S7. Pure functions (no hooks,
 * no I/O) so they run in TanStack `select` + are unit-testable.
 *
 * Do NOT confuse with `adapters/share.ts` (the legacy contractor share path).
 *
 * ── ONE SOURCE OF TRUTH note (G-WHOLE) ──────────────────────────────────────
 * The AUTHORITATIVE preset ceiling lives SERVER-SIDE in
 * `packages/db/src/schema/external-share.ts` (`PARTY_PRESET_CEILINGS`) and is
 * re-validated fail-closed on every create/update — a request that asks for
 * MORE than the ceiling is REJECTED (`exceeds_ceiling` / `cannot_widen`), never
 * silently clamped. The FE cannot import `@emapp/db` (server-only), so this is a
 * FE-side MIRROR used ONLY to:
 *   • auto-fill the preset default when a party-type is chosen, and
 *   • disable/grey toggles the ceiling forbids (so the UI can only NARROW).
 * It is a UX convenience, NOT the enforcement boundary. If this mirror ever
 * drifts to be WIDER than the server, the server still rejects the over-wide
 * payload (proven in the red-team) — fail-closed. `external-share.spec.ts`
 * pins that this mirror never exceeds the documents.actions.download ⊆
 * documents.on coherence the schema enforces.
 */
import type {
  ExternalSharePartyType,
  ExternalSharePermissions,
  ExternalShareScopeType,
  ExternalShareView,
} from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';

// ── FE ceiling mirror (see header note) ─────────────────────────────────────

export interface FePartyCeiling {
  maxScopeType: ExternalShareScopeType;
  permissions: ExternalSharePermissions;
  allowSensitive: boolean;
  maxTtlDays: number | null;
}

const FULL_READ_DOWNLOAD: ExternalSharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: true },
};

const OVERVIEW_DOCS_DOWNLOAD: ExternalSharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: false },
};

/** Mirror of the server `PARTY_PRESET_CEILINGS` (server is the source of truth;
 *  this only narrows the UI). Keep BYTE-EQUIVALENT to the schema map. */
export const FE_PARTY_CEILINGS: Record<ExternalSharePartyType, FePartyCeiling> = {
  developer: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  developer_lawyer: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  tenant_lawyer: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  bank: {
    maxScopeType: 'project',
    permissions: OVERVIEW_DOCS_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  supervisor: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  appraiser: {
    maxScopeType: 'apartment',
    permissions: OVERVIEW_DOCS_DOWNLOAD,
    allowSensitive: false,
    maxTtlDays: 90,
  },
  surveyor: {
    maxScopeType: 'apartment',
    permissions: OVERVIEW_DOCS_DOWNLOAD,
    allowSensitive: false,
    maxTtlDays: 90,
  },
  committee: {
    maxScopeType: 'project',
    permissions: {
      overview: { on: true },
      documents: { on: false, actions: { download: false } },
      signatures: { on: true },
    },
    allowSensitive: false,
    maxTtlDays: 365,
  },
  special_admin: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
};

/** Canonical display order for the party chips (most-common first). */
export const EXTERNAL_SHARE_PARTY_TYPES: ExternalSharePartyType[] = [
  'developer',
  'developer_lawyer',
  'tenant_lawyer',
  'bank',
  'supervisor',
  'appraiser',
  'surveyor',
  'committee',
  'special_admin',
];

/** The preset DEFAULT a chosen party-type auto-fills to: the ceiling itself,
 *  but sensitive FORCED OFF (#486 caveat — non-sensitive only this slice) and a
 *  conservative default TTL (30d, or the ceiling cap if shorter). Pure. */
export function presetDefaultFor(partyType: ExternalSharePartyType): {
  scopeType: ExternalShareScopeType;
  permissions: ExternalSharePermissions;
  ttlDays: number;
} {
  const c = FE_PARTY_CEILINGS[partyType];
  const ttlDays = c.maxTtlDays === null ? 30 : Math.min(30, c.maxTtlDays);
  return {
    scopeType: c.maxScopeType,
    // structuredClone so callers can mutate their copy without touching the mirror.
    permissions: JSON.parse(JSON.stringify(c.permissions)) as ExternalSharePermissions,
    ttlDays,
  };
}

/** Does the party ceiling permit sensitive at all? (Used to label why a party
 *  is blocked this slice — see #486 caveat in the sheet.) */
export function ceilingAllowsSensitive(partyType: ExternalSharePartyType): boolean {
  return FE_PARTY_CEILINGS[partyType].allowSensitive;
}

// ── Wire → ViewModel ────────────────────────────────────────────────────────

export interface ExternalShareViewModel {
  id: string;
  partyType: ExternalSharePartyType;
  scopeType: ExternalShareScopeType;
  scopeCount: number;
  permissions: ExternalSharePermissions;
  /** Active sections, e.g. "2 / 3" — at-a-glance grant footprint. */
  permissionSummary: string;
  allowSensitive: boolean;
  otpRequired: boolean;
  isRevoked: boolean;
  expiresAtIso: string | null;
  /** True once `expiresAt` is in the past (access is dead). */
  isExpired: boolean;
  /** Live-countdown seed: ms remaining until expiry (negative once expired,
   *  null when no expiry set). The component ticks from this. */
  msUntilExpiry: number | null;
  createdAtIso: string;
  createdRelative: string;
  updatedAtIso: string;
  /** Last touch (created/extended/resent) as a relative string — the BE view
   *  has NO last-ACCESSED field, so "last activity" is updatedAt, labelled
   *  honestly (not a fake "last seen by recipient"). */
  lastActivityRelative: string;
}

/** Active sections in a permission grant (overview / documents / signatures —
 *  the 3 resource axes; download is an action under documents). */
export function countActiveSections(p: ExternalSharePermissions): number {
  return [p.overview.on, p.documents.on, p.signatures.on].filter(Boolean).length;
}

export const EXTERNAL_SHARE_SECTION_COUNT = 3;

export function toExternalShareViewModel(
  s: ExternalShareView,
  locale: DisplayLocale = 'he',
  now: Date = new Date(),
): ExternalShareViewModel {
  const active = countActiveSections(s.permissions);
  const expiresMs = s.expiresAt ? s.expiresAt.getTime() : null;
  const msUntilExpiry = expiresMs === null ? null : expiresMs - now.getTime();
  return {
    id: s.id,
    partyType: s.partyType,
    scopeType: s.scopeType,
    scopeCount: s.scopeIds.length,
    permissions: s.permissions,
    permissionSummary: `${active} / ${EXTERNAL_SHARE_SECTION_COUNT}`,
    allowSensitive: s.allowSensitive,
    otpRequired: s.otpRequired,
    isRevoked: s.revokedAt !== null,
    expiresAtIso: s.expiresAt ? s.expiresAt.toISOString() : null,
    isExpired: msUntilExpiry !== null && msUntilExpiry <= 0,
    msUntilExpiry,
    createdAtIso: s.createdAt.toISOString(),
    createdRelative: formatRelative(s.createdAt, locale),
    updatedAtIso: s.updatedAt.toISOString(),
    lastActivityRelative: formatRelative(s.updatedAt, locale),
  };
}

export function toExternalShareViewModels(
  items: ExternalShareView[],
  locale: DisplayLocale = 'he',
  now: Date = new Date(),
): ExternalShareViewModel[] {
  return items.map((s) => toExternalShareViewModel(s, locale, now));
}
