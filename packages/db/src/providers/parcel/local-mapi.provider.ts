import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../../client';
import { parcelLookup } from '../../schema/artifacts';

import type {
  IParcelDataProvider,
  ParcelLookupQuery,
  ParcelLookupResult,
} from './parcel.interface';

/**
 * LocalMapiParcelDataProvider — the P3b engine (§7.1 decision-1): resolves
 * block/parcel(+sub) against the LOCAL `parcel_lookup` reference table that the
 * `scripts/load-parcel-lookup.ts` loader fills from the bulk-מפ"י open dataset.
 * ZERO egress at runtime — the "lookup" is a single parameterized SELECT on our
 * own DB (drizzle binds every value; nothing is ever interpolated).
 *
 * DB handle: the shared app `db` (PostgresCacheProvider precedent) — NOT
 * withTenant. Deliberate and safe: parcel_lookup is a GLOBAL public-national-
 * record table with NO org_id and NO RLS (rationale in migration 0074); there
 * is no tenant context to scope by, and app_user holds SELECT-only on it.
 *
 * Matching: a provided subParcel must match exactly; an ABSENT subParcel
 * matches the parcel's NULL-sub row (the whole-parcel record). providerId =
 * 'local-mapi' — stamped on parcel_setups.source when found (the review flag;
 * never user input).
 */
export class LocalMapiParcelDataProvider implements IParcelDataProvider {
  readonly providerId = 'local-mapi' as const;

  async lookup(q: ParcelLookupQuery): Promise<ParcelLookupResult> {
    // ZERO-PII egress (§5): the query uses ONLY block/parcel/sub — public
    // land-registration numbers. No org/user/project data exists here at all.
    const [row] = await db
      .select({
        city: parcelLookup.city,
        centroidLat: parcelLookup.centroidLat,
        centroidLng: parcelLookup.centroidLng,
      })
      .from(parcelLookup)
      .where(
        and(
          eq(parcelLookup.blockNumber, q.blockNumber),
          eq(parcelLookup.parcelNumber, q.parcelNumber),
          q.subParcel !== undefined
            ? eq(parcelLookup.subParcel, q.subParcel)
            : isNull(parcelLookup.subParcel),
        ),
      )
      .limit(1);

    if (!row) return { found: false, providerId: this.providerId };
    return {
      found: true,
      ...(row.city !== null ? { city: row.city } : {}),
      ...(row.centroidLat !== null ? { centroidLat: row.centroidLat } : {}),
      ...(row.centroidLng !== null ? { centroidLng: row.centroidLng } : {}),
      providerId: this.providerId,
    };
  }
}
