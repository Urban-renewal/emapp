import type { Apartment, ApartmentStatus } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { ApartmentViewModel } from '@/models/apartment.vm';

/**
 * Wire → ViewModel adapter for Apartment.
 *
 * Hebrew labels for the locked `apartment_status` enum are owned in
 * the adapter (same pattern as Project — labels live with the enum
 * mapping; i18n messages are for free-text UI strings).
 */

const STATUS_LABELS_HE: Record<ApartmentStatus, string> = {
  pending: 'בהמתנה',
  contacted: 'נוצר קשר',
  meeting: 'בפגישה',
  signed: 'חתום',
  refused: 'סירב',
  unreachable: 'לא נגיש',
};

const STATUS_LABELS_EN: Record<ApartmentStatus, string> = {
  pending: 'Pending',
  contacted: 'Contacted',
  meeting: 'Meeting',
  signed: 'Signed',
  refused: 'Refused',
  unreachable: 'Unreachable',
};

const STATUS_INTENTS: Record<ApartmentStatus, ApartmentViewModel['intent']> = {
  pending: 'neutral',
  contacted: 'warning',
  meeting: 'warning',
  signed: 'success',
  refused: 'danger',
  unreachable: 'danger',
};

export function toApartmentViewModel(a: Apartment, locale: 'he' | 'en' = 'he'): ApartmentViewModel {
  const labels = locale === 'he' ? STATUS_LABELS_HE : STATUS_LABELS_EN;
  return {
    id: a.id,
    buildingId: a.buildingId,
    number: a.number,
    floor: a.floor,
    sizeSqm: a.sizeSqm,
    rooms: a.rooms,
    status: a.status,
    statusLabel: labels[a.status],
    intent: STATUS_INTENTS[a.status],
    factsLine: composeFacts(a.floor, a.rooms, a.sizeSqm, locale),
    notes: a.notes ?? null,
    isArchived: a.archivedAt !== null,
    createdRelative: formatRelative(a.createdAt, locale),
    statusChangedRelative: formatRelative(a.statusChangedAt, locale),
  };
}

export function toApartmentViewModels(
  items: Apartment[],
  locale: 'he' | 'en' = 'he',
): ApartmentViewModel[] {
  return items.map((a) => toApartmentViewModel(a, locale));
}

function composeFacts(
  floor: number | null,
  rooms: number | null,
  sizeSqm: number | null,
  locale: 'he' | 'en',
): string {
  const parts: string[] = [];
  if (floor !== null) {
    parts.push(locale === 'he' ? `קומה ${floor}` : `Floor ${floor}`);
  }
  if (rooms !== null) {
    parts.push(locale === 'he' ? `${rooms} חדרים` : `${rooms} rooms`);
  }
  if (sizeSqm !== null) {
    parts.push(locale === 'he' ? `${sizeSqm} מ"ר` : `${sizeSqm} m²`);
  }
  return parts.join(' · ');
}

export const APARTMENT_STATUS_LABELS_HE = STATUS_LABELS_HE;
export const APARTMENT_STATUS_LABELS_EN = STATUS_LABELS_EN;
export const APARTMENT_STATUS_INTENTS = STATUS_INTENTS;
