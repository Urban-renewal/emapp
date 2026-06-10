import type { TenantDetail, TenantListItem, TenantSampleOwner } from '@emapp/shared-types';

/**
 * Provider-tier ViewModels — D.37 read-only cross-tenant view.
 *
 * Threat-model linkage (D.37 + Doc 07 §7.10):
 *  - The owner-sample names are ALREADY masked at the wire (`nameMasked`
 *    pattern `•••••••XX`). The VM passes them through verbatim; pages
 *    MUST NOT attempt to "unmask" or display unmasked names from any
 *    other source. The VM type makes the contract explicit by NOT
 *    declaring a `name` field — only `nameMasked` exists at the VM
 *    layer too.
 *  - Phone is `phoneMasked` with the same posture.
 *  - `national_id` is intentionally absent from the wire AND the VM —
 *    Provider tier has no field-level unmask flag in the MVP.
 */
export interface ProviderTenantListItemVM {
  /** Verbatim. */
  id: string;
  /** Verbatim — org display name. */
  name: string;
  /** Verbatim — org slug (used in URLs). */
  slug: string;
  /** "לפני 3 ימים" / ISO date past 30 days. */
  createdRelative: string;
  /** Underlying ISO timestamp for sorting + cursor display. */
  createdAtIso: string;
  /** D.07 — display "ארכוב" badge when set. */
  isArchived: boolean;
  /** D.49 — display "מושעה" (frozen) badge when set; distinct from archived. */
  isSuspended: boolean;
  /** Flat formatted counts for table cells. */
  userCount: number;
  projectCount: number;
  ownerCount: number;
}

/** Sample-owner cell on the tenant detail page — masked-only. */
export interface ProviderTenantSampleOwnerVM {
  id: string;
  /** Already-masked from BE; VM passes through. */
  nameMasked: string;
  email: string | null;
  /** Already-masked from BE; VM passes through. */
  phoneMasked: string | null;
  isArchived: boolean;
}

export interface ProviderTenantDetailVM {
  id: string;
  name: string;
  slug: string;
  createdRelative: string;
  createdAtIso: string;
  isArchived: boolean;
  /** D.49 — operational suspension state (distinct from archive). Drives
   *  which write action the console offers (suspend vs reactivate) and a
   *  suspended banner. */
  isSuspended: boolean;
  /** "לפני 3 ימים" relative freeze time; null when active. */
  suspendedRelative: string | null;
  /** Operator note captured at suspend time; null when active. */
  suspendedReason: string | null;
  /** Detail page surfaces 5 counts (vs the 3 on the list — adds
   *  importJobs + signatureRequests). */
  counts: {
    users: number;
    projects: number;
    owners: number;
    importJobs: number;
    signatureRequests: number;
  };
  /** ≤ 5 most-recently-created owners, masked PII only. */
  sampleOwners: ProviderTenantSampleOwnerVM[];
}

/**
 * P4 — Org-users (members) row on the provider tenant-users page.
 * Masked-only (name + email); the VM deliberately has NO `name` / `email`
 * field — only the masked forms exist, mirroring the sample-owner VM. No
 * national_id / phone anywhere (not on the wire, not in the VM).
 */
export interface ProviderTenantUserVM {
  /** Membership id — list key. */
  id: string;
  /** Underlying user id (opaque UUID, NOT PII). */
  userId: string;
  /** Already-masked from BE; VM passes through. */
  nameMasked: string;
  /** Already-masked from BE; VM passes through. */
  emailMasked: string;
  /** Org membership role (manager | agent | viewer). */
  role: string;
  /** Custom org-scope role keys (empty when none). */
  roleKeys: string[];
  status: 'invited' | 'active' | 'revoked';
  isPrimary: boolean;
  /** "לפני 3 ימים" relative last login; null if never. */
  lastLoginRelative: string | null;
  /** "לפני 3 ימים" relative join time. */
  createdRelative: string;
}

// ── Re-exports for completeness so consumers can `import type` the
// underlying wire types alongside the VMs without a second import.
export type { TenantDetail, TenantListItem, TenantSampleOwner };
