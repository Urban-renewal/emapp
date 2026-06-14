import type { Apartment, ApartmentStatus } from '@emapp/shared-types';

import type { ApartmentListPage } from '@/lib/api/apartments';

/**
 * The two cached shapes under the ['apartments'] key family: the single-record
 * detail cache (`useApartment`) and the building list page (`useApartmentList`).
 * A status mutation has to patch whichever (or both) hold the target apartment.
 */
export type ApartmentCache = Apartment | ApartmentListPage;

function isListPage(data: ApartmentCache): data is ApartmentListPage {
  return 'items' in data;
}

/**
 * Pure optimistic transform for an apartment status change — patches the
 * matching apartment's `status` (+ `statusChangedAt`, so the "changed just now"
 * label stays truthful) in EITHER cache shape, immutably (new object + new
 * items array; never mutate the cached value or TanStack won't re-render).
 * Non-matching records/shapes pass through untouched. `at` is injected so the
 * hook owns the timestamp and tests stay deterministic.
 */
export function applyApartmentStatus(
  data: ApartmentCache | undefined,
  id: string,
  status: ApartmentStatus,
  at: Date,
): ApartmentCache | undefined {
  if (!data) return data;
  if (isListPage(data)) {
    return {
      ...data,
      items: data.items.map((a) => (a.id === id ? { ...a, status, statusChangedAt: at } : a)),
    };
  }
  return data.id === id ? { ...data, status, statusChangedAt: at } : data;
}
