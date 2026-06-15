import type {
  IParcelDataProvider,
  ParcelLookupQuery,
  ParcelLookupResult,
} from './parcel.interface';

/**
 * StubParcelDataProvider — the zero-egress DEFAULT (P3b;
 * docs/DESIGN-phase3-parcel-autosetup.md §3/§5 "אפס-egress כברירת-מחדל").
 * Always answers { found: false } — it NEVER reads the DB, NEVER touches the
 * network, performs NO side effects. Create therefore always falls back to the
 * manual path (source stays 'manual', provider_status='not_found') until the
 * owner enables a real engine via PARCEL_LOOKUP_ENABLED. providerId = 'stub'.
 */
export class StubParcelDataProvider implements IParcelDataProvider {
  readonly providerId = 'stub' as const;

  async lookup(_q: ParcelLookupQuery): Promise<ParcelLookupResult> {
    return { found: false, providerId: this.providerId };
  }
}
