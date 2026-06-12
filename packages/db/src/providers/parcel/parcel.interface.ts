/**
 * IParcelDataProvider — the pluggable seam for resolving a public גוש/חלקה
 * (block/parcel[/sub]) to its parcel data (P3b;
 * docs/DESIGN-phase3-parcel-autosetup.md §3 flow / §5 invariants / §6 P3b /
 * §7.1 decision-1). Mirrors the IExtractionProvider DI-token-and-factory
 * pattern: the DEFAULT is a zero-egress Stub that always answers "no data"
 * (the manual path); the LocalMapi engine reads the parcel_lookup reference
 * table loaded from the bulk-מפ"י open dataset (zero egress at runtime); a
 * future GovMap engine (P3d, owner-gated) plugs in behind the same interface,
 * selected by `parcelDataProviderFactory()`.
 *
 * SECURITY (§5 — ZERO-PII EGRESS, enforced by test): the lookup query carries
 * ONLY the public land-registration numbers (block/parcel/sub). Implementations
 * MUST NEVER receive or transmit org/user/project identifiers, names, or any
 * tenant data. The result is PUBLIC NATIONAL RECORD data (city, centroid) —
 * not PII, not tenant-scoped.
 */

/** The lookup key — PUBLIC land-registration numbers only (never PII). */
export interface ParcelLookupQuery {
  blockNumber: string;
  parcelNumber: string;
  subParcel?: string;
}

/**
 * The engine answer. `providerId` is stamped by the engine itself and is the
 * ONLY legitimate writer of parcel_setups.source (the review flag) — it never
 * comes from user input.
 */
export interface ParcelLookupResult {
  found: boolean;
  city?: string;
  centroidLat?: number;
  centroidLng?: number;
  providerId: string;
}

export interface IParcelDataProvider {
  lookup(q: ParcelLookupQuery): Promise<ParcelLookupResult>;
}
