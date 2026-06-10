/**
 * Ownership adapter — §SOLID-H1 closure.
 *
 * Wire `ApartmentOwner` → `OwnershipViewModel`. Pure function. Used by
 * `useApartmentOwners` via TanStack `select` so the page consumes
 * VMs only (the previous bypass that destructured raw wire shape
 * eroded the §9.8 discipline).
 *
 * Note: ownerships have no enum status / no relative time, so the
 * adapter is mostly a rename layer today. It still exists because:
 *   1. Doc 05 §9.8 says EVERY entity gets an adapter (uniformity).
 *   2. A future BE field add (e.g. `acceptedAt`) needs exactly one
 *      file to change — this one.
 *   3. Tests pin the wire → VM mapping, catching drift.
 */
import type { ApartmentOwner } from '@emapp/shared-types';

import type { OwnershipViewModel } from '@/models/ownership.vm';

export function toOwnershipViewModel(o: ApartmentOwner): OwnershipViewModel {
  return {
    ownershipId: o.ownershipId,
    ownerId: o.id,
    // Shell owner — no name/national_id yet; show a neutral placeholder.
    displayName: o.name ?? 'ללא שם',
    nationalIdMasked: o.nationalIdMasked ?? '—',
    phoneMasked: o.phoneMasked,
    ownershipPct: o.ownershipPct,
    relationship: o.relationship,
    role: o.role,
  };
}

export function toOwnershipViewModels(items: ApartmentOwner[]): OwnershipViewModel[] {
  return items.map(toOwnershipViewModel);
}
