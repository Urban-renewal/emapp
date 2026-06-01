/**
 * Wire → ViewModel adapter for Member (Phase 4c S1). Pure function;
 * docs/05 §9.8 pattern (same as projects/owners/etc.).
 *
 * Hebrew labels for role + state are owned HERE, not in i18n messages,
 * because they are a 1:1 mapping from a locked enum (D.17 OrgRoleEnum)
 * to product-specific terminology. Drift between the enum and the
 * label table is caught by an exhaustive `Object.keys` test in
 * `member.spec.ts`.
 *
 * State labels deliberately distinguish the three lifecycle phases
 * (PENDING / ACTIVE / REVOKED) so a Manager looking at the list can
 * see at a glance whose invite has not been accepted yet — D.27
 * surface visibility for incomplete enrolment.
 */

import { DEFAULT_AGENT_CAPABILITIES, type Member, type OrgRole } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { MemberState, MemberViewModel } from '@/models/member.vm';

const ROLE_LABELS_HE: Record<OrgRole, string> = {
  manager: 'מנהל',
  agent: 'אגנט',
  viewer: 'צופה',
};

const ROLE_LABELS_EN: Record<OrgRole, string> = {
  manager: 'Manager',
  agent: 'Agent',
  viewer: 'Viewer',
};

const STATE_LABELS_HE: Record<MemberState, string> = {
  pending: 'ממתין לאישור',
  active: 'פעיל',
  revoked: 'בוטל',
};

const STATE_LABELS_EN: Record<MemberState, string> = {
  pending: 'Pending',
  active: 'Active',
  revoked: 'Revoked',
};

const STATE_COLORS: Record<MemberState, MemberViewModel['stateColor']> = {
  pending: 'amber',
  active: 'emerald',
  revoked: 'red',
};

function deriveState(m: Member): MemberState {
  if (m.revokedAt !== null) return 'revoked';
  if (m.acceptedAt === null) return 'pending';
  return 'active';
}

export function toMemberViewModel(m: Member, locale: DisplayLocale = 'he'): MemberViewModel {
  const state = deriveState(m);
  const roleLabels = locale === 'en' ? ROLE_LABELS_EN : ROLE_LABELS_HE;
  const stateLabels = locale === 'en' ? STATE_LABELS_EN : STATE_LABELS_HE;
  return {
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    roleLabel: roleLabels[m.role],
    state,
    stateLabel: stateLabels[state],
    stateColor: STATE_COLORS[state],
    isPrimary: m.isPrimary,
    isPending: state === 'pending',
    isActive: state === 'active',
    isRevoked: state === 'revoked',
    invitedBy: m.invitedBy,
    createdRelative: formatRelative(m.createdAt, locale),
    createdAtIso: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
    // BE always sends capabilities; fall back to the locked default for any
    // pre-capability fixture/consumer (add-only wire safety).
    capabilities: m.capabilities ?? DEFAULT_AGENT_CAPABILITIES,
  };
}

export function toMemberViewModels(
  items: Member[],
  locale: DisplayLocale = 'he',
): MemberViewModel[] {
  return items.map((m) => toMemberViewModel(m, locale));
}

/** Exported for adapter tests + future Storybook stories. */
export const MEMBER_ROLE_LABELS_HE = ROLE_LABELS_HE;
export const MEMBER_ROLE_LABELS_EN = ROLE_LABELS_EN;
export const MEMBER_STATE_LABELS_HE = STATE_LABELS_HE;
export const MEMBER_STATE_LABELS_EN = STATE_LABELS_EN;
export const MEMBER_STATE_COLORS = STATE_COLORS;
