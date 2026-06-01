/**
 * Member ViewModel — Phase 4c S1.
 *
 * The Member wire shape (`@emapp/shared-types/member.ts`) carries NO
 * PII (no national_id, no phone, no encryption-bearing fields). Email
 * and name are cleartext on the wire — the Manager who reads /members
 * already knows these from when they invited the user. `<NameDisplay>`
 * is still required at render time (bidi-spoofing defense, §v9-H-3),
 * but no masking is needed because there is nothing to mask.
 *
 * State derivation (D.27 invite lifecycle):
 *   - `acceptedAt === null && revokedAt === null` → PENDING (invite sent)
 *   - `acceptedAt !== null && revokedAt === null` → ACTIVE
 *   - `revokedAt !== null` → REVOKED (showed in list with badge; can no
 *     longer be modified)
 *
 * `isPrimary` is the org-creator's membership — UI hides "revoke" for
 * primary to avoid bricking the org (the BE also refuses via
 * `cannot_remove_last_manager`, but defense in depth on the FE keeps
 * the Manager from clicking a button that can never succeed).
 */

import type { AgentCapabilities, OrgRole } from '@emapp/shared-types';

export type MemberState = 'pending' | 'active' | 'revoked';

export interface MemberViewModel {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  roleLabel: string;
  state: MemberState;
  stateLabel: string;
  stateColor: 'gray' | 'amber' | 'emerald' | 'red';
  isPrimary: boolean;
  isPending: boolean;
  isActive: boolean;
  isRevoked: boolean;
  invitedBy: string | null;
  createdRelative: string;
  createdAtIso: string;
  /** D.46/D.54 — the stored agent capability set. The BE always populates
   *  it on every Member response; we fall back to the locked default if a
   *  pre-capability fixture omits it. Meaningful for enforcement only when
   *  `role === 'agent'` (managers implicitly hold all; viewers none). */
  capabilities: AgentCapabilities;
}
