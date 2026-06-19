import type { ApartmentStatus } from '@emapp/shared-types';

/**
 * Apartment ViewModel. The apartment_status enum drives the Manager
 * UX (pending → contacted → meeting → signed / refused / unreachable);
 * the adapter encodes Hebrew labels + a semantic intent aligned with the
 * project status palette (neutral/warning/success/danger).
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
  intent: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** "קומה 2 · 3.5 חדרים · 85 מ\"ר" — composed, with present-only fields. */
  factsLine: string;
  notes: string | null;
  isArchived: boolean;
  createdRelative: string;
  statusChangedRelative: string;
}
