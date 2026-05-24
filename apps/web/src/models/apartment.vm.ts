import type { ApartmentStatus } from '@emapp/shared-types';

/**
 * Apartment ViewModel. The apartment_status enum drives the Manager
 * UX (pending → contacted → meeting → signed / refused / unreachable);
 * the adapter encodes Hebrew labels + a color bucket aligned with the
 * project status palette (gray/amber/emerald/red).
 */
export interface ApartmentViewModel {
  id: string;
  buildingId: string;
  /** Verbatim — "1", "12א", etc. */
  number: string;
  floor: number | null;
  sizeSqm: number | null;
  rooms: number | null;
  status: ApartmentStatus;
  statusLabel: string;
  statusColor: 'gray' | 'amber' | 'emerald' | 'red';
  /** "קומה 2 · 3.5 חדרים · 85 מ\"ר" — composed, with present-only fields. */
  factsLine: string;
  notes: string | null;
  isArchived: boolean;
  createdRelative: string;
  statusChangedRelative: string;
}
