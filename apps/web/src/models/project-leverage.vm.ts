/**
 * Battle-Map BM-1 — leverage card ViewModel (read-only "מפת קרב" entry).
 *
 * The adapter (apps/web/src/adapters/project.ts → toProjectLeverageViewModel)
 * folds the wire `ProjectLeverage` into this shape: the headline `currentPct`
 * + its basis pass through; the single top-leverage owner (when one is movable)
 * is reshaped so the card stays presentational. `leverage` is `null` for the
 * calm all-clear / nothing-movable state.
 *
 * PII posture: `ownerName` is `view_owner_pii`-gated on the BE and arrives
 * `null` when the caller lacks the capability (name only — NEVER national_id /
 * phone). The card wraps it in `<NameDisplay>`. `apartmentLabel` is the
 * `formatApartmentLabel`-normalised designation (dedups an already-"דירה"
 * prefixed number).
 */
import type { ConsentBasis } from '@emapp/shared-types';

export interface ProjectLeverageOwnerViewModel {
  /** Owner id — used for read-safe navigation to the owner record. */
  ownerId: string;
  /** Apartment id — used for read-safe navigation to the apartment. */
  apartmentId: string;
  /** view_owner_pii-gated owner name; null when masked (NEVER national_id/phone). */
  ownerName: string | null;
  /** `formatApartmentLabel`-normalised apartment designation (e.g. "דירה 4"). */
  apartmentLabel: string;
  /** This owner's own share of the apartment, rounded to a whole percent [0,100]. */
  ownerSharePct: number;
  /** The headline consent % AFTER flipping this owner to signed (int %). */
  projectedPct: number;
  /** Does flipping this owner push the headline to/above the project target? */
  crossesThreshold: boolean;
}

export interface ProjectLeverageViewModel {
  /** The CURRENT headline share-weighted consent % (int), same source as the board. */
  currentPct: number;
  /** The consent-% computation basis (always 'share' today) — drives the basis label. */
  basis: ConsentBasis;
  /** The single top-leverage owner; null for the calm all-clear / nothing-movable state. */
  leverage: ProjectLeverageOwnerViewModel | null;
}
