import type { Building } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { BuildingViewModel } from '@/models/building.vm';

/** Wire → ViewModel adapter for Building (docs/05 §9.8). Pure function. */
export function toBuildingViewModel(b: Building, locale: 'he' | 'en' = 'he'): BuildingViewModel {
  return {
    id: b.id,
    projectId: b.projectId,
    address: b.address,
    city: b.city,
    addressLine: composeAddress(b.address, b.city),
    parcelSummary: composeParcelSummary(b.block, b.parcel, b.subparcel, locale),
    aptCount: b.aptCount,
    notes: b.notes ?? null,
    isArchived: b.archivedAt !== null,
    createdRelative: formatRelative(b.createdAt, locale),
    createdAtIso: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt),
  };
}

export function toBuildingViewModels(
  items: Building[],
  locale: 'he' | 'en' = 'he',
): BuildingViewModel[] {
  return items.map((b) => toBuildingViewModel(b, locale));
}

function composeAddress(address: string, city: string): string {
  // RTL-safe: Hebrew commas render correctly inside an LTR-flagged span.
  return city ? `${address}, ${city}` : address;
}

function composeParcelSummary(
  block: string | null,
  parcel: string | null,
  subparcel: string | null,
  locale: 'he' | 'en',
): string | null {
  if (!block && !parcel && !subparcel) return null;
  const labels =
    locale === 'he'
      ? { block: 'גוש', parcel: 'חלקה', subparcel: 'תת-חלקה' }
      : { block: 'Block', parcel: 'Parcel', subparcel: 'Sub-parcel' };
  const parts: string[] = [];
  if (block) parts.push(`${labels.block} ${block}`);
  if (parcel) parts.push(`${labels.parcel} ${parcel}`);
  if (subparcel) parts.push(`${labels.subparcel} ${subparcel}`);
  return parts.join(' · ');
}
