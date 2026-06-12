import {
  LocalMapiParcelDataProvider,
  StubParcelDataProvider,
  type IParcelDataProvider,
} from '@emapp/db';

/**
 * PARCEL_DATA_PROVIDER — the DI seam (mirrors EXTRACTION_PROVIDER /
 * SMS_PROVIDER / STORAGE_PROVIDER). The token name stays fixed; only the
 * concrete class resolved by `parcelDataProviderFactory` changes when an
 * engine is enabled. Injected positionally as ParcelSetupsService's FIRST
 * constructor arg.
 */
export const PARCEL_DATA_PROVIDER = 'PARCEL_DATA_PROVIDER';

/**
 * Parcel-data engine selection (P3b — docs/DESIGN-phase3-parcel-autosetup.md
 * §3/§5/§6 P3b/§7.1 decision-1) — the single config-swap point:
 *
 *   - `PARCEL_LOOKUP_ENABLED === 'true'` (exactly) →
 *     `LocalMapiParcelDataProvider`: resolves גוש/חלקה against the LOCAL
 *     `parcel_lookup` reference table (bulk-מפ"י, loaded by
 *     packages/db/scripts/load-parcel-lookup.ts). ZERO egress at runtime — the
 *     lookup is a parameterized SELECT on our own DB.
 *   - Else (unset / anything else) → `StubParcelDataProvider` — the
 *     zero-egress DEFAULT (§5 precedent): always "no data", create falls back
 *     to the manual path. No external source is consulted until the owner
 *     flips the flag.
 *
 * A future GovMapParcelDataProvider (P3d — owner-gated, token + ToS
 * verification first) branches here behind its own env creds.
 *
 * NOTE: like the extraction factory (and unlike SMS/storage), the Stub is a
 * legitimate production default — lookup is an ENRICHMENT (fail-open §5), so
 * there is no production fail-fast guard here.
 */
export function parcelDataProviderFactory(): IParcelDataProvider {
  if (process.env['PARCEL_LOOKUP_ENABLED'] === 'true') {
    return new LocalMapiParcelDataProvider();
  }
  return new StubParcelDataProvider();
}
