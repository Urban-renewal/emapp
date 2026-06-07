import type { TenantDetail, TenantListItem, TenantSampleOwner } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type {
  ProviderTenantDetailVM,
  ProviderTenantListItemVM,
  ProviderTenantSampleOwnerVM,
} from '@/models/provider-tenant.vm';

/**
 * Wire → ViewModel for D.37 Provider Admin tenant views.
 *
 * Pure functions; safe inside TanStack `select`. No `any`, no `as`
 * sniffing — caller is expected to have already run the defensive
 * Zod `.parse()` on the wire payload (done in `lib/api/provider.ts`).
 *
 * PII rule (D.37 + Doc 07 §7.10): the wire already carries `nameMasked`
 * + `phoneMasked` only. The adapter passes them through verbatim — no
 * format-stripping that could accidentally expose internal pattern
 * details (e.g. \"the masked pattern reveals name length\").
 */

export function toTenantListItemVM(
  row: TenantListItem,
  locale: 'he' | 'en' = 'he',
): ProviderTenantListItemVM {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdRelative: formatRelative(row.createdAt, locale),
    createdAtIso: row.createdAt.toISOString(),
    isArchived: row.archivedAt !== null,
    isSuspended: row.suspendedAt !== null,
    userCount: row.counts.users,
    projectCount: row.counts.projects,
    ownerCount: row.counts.owners,
  };
}

export function toTenantListItemVMs(
  rows: TenantListItem[],
  locale: 'he' | 'en' = 'he',
): ProviderTenantListItemVM[] {
  return rows.map((r) => toTenantListItemVM(r, locale));
}

export function toSampleOwnerVM(o: TenantSampleOwner): ProviderTenantSampleOwnerVM {
  return {
    id: o.id,
    nameMasked: o.nameMasked,
    email: o.email,
    phoneMasked: o.phoneMasked,
    isArchived: o.archivedAt !== null,
  };
}

export function toTenantDetailVM(
  row: TenantDetail,
  locale: 'he' | 'en' = 'he',
): ProviderTenantDetailVM {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdRelative: formatRelative(row.createdAt, locale),
    createdAtIso: row.createdAt.toISOString(),
    isArchived: row.archivedAt !== null,
    isSuspended: row.suspendedAt !== null,
    suspendedRelative: row.suspendedAt ? formatRelative(row.suspendedAt, locale) : null,
    suspendedReason: row.suspendedReason,
    counts: {
      users: row.counts.users,
      projects: row.counts.projects,
      owners: row.counts.owners,
      importJobs: row.counts.importJobs,
      signatureRequests: row.counts.signatureRequests,
    },
    sampleOwners: row.sampleOwners.map(toSampleOwnerVM),
  };
}
