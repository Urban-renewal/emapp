import { z } from 'zod';

import { OwnerSchema } from './owner';

// Canonical Ownership contract (Doc 11 SoT; Phase 3 Slice 5).
//
// LOCKED INVARIANT (Phase-1 constraint trigger trg_ownerships_sum_check,
// DEFERRABLE INITIALLY DEFERRED): for an apartment, SUM(ownership_pct)
// over ACTIVE rows (ended_at IS NULL) must be 0 OR exactly 100 at COMMIT.
// Therefore ownership composition is ATOMIC per apartment — a lone
// add/patch/delete in its own transaction can never satisfy =100. The
// only coherent write is a full-set REPLACE. docs/09 §3.13's per-row
// shape is doc-drift vs this locked trigger (recorded — D.25 / PROGRESS;
// no Gate-2 deviation: we conform TO the locked invariant).

// Feature A (P2 / D.25 sum-trigger change) — owner vs renter. A renter
// does NOT sign and is EXCLUDED from the 100% ownership sum; renters carry
// ownershipPct === 0 (option (a): column stays NOT NULL, the DB trigger
// excludes by relationship). This Zod enum is the authoritative API-edge
// enforcement (mirrors the DB CHECK ('owner','renter')).
export const RelationshipSchema = z.enum(['owner', 'renter']);
export type Relationship = z.infer<typeof RelationshipSchema>;

export const OwnershipSchema = z.object({
  id: z.string().uuid(),
  apartmentId: z.string().uuid(),
  ownerId: z.string().uuid(),
  ownershipPct: z.number().min(0).max(100),
  // S3b — the EXACT Tabu share as a rational fraction. `ownershipPct` above is
  // the derived 2-decimal compat value; these two carry the lossless share
  // (e.g. 1/3). Denominator is always > 0 (DB CHECK ownerships_share_den_positive).
  shareNumerator: z.number().int().min(0),
  shareDenominator: z.number().int().positive(),
  relationship: RelationshipSchema,
  role: z.string().max(50).nullable(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Ownership = z.infer<typeof OwnershipSchema>;

// S3b — the canonical share is the EXACT FRACTION (share_numerator /
// share_denominator). `ownershipPct` is a DERIVED display value only — the
// server NEVER trusts a caller-supplied pct: when a fraction is given, pct is
// recomputed from it (deriveShareFraction prefers the fraction); when only a
// pct is given, the fraction is derived from pct (num=round(pct*100), den=10000).
//
// Upper bound on the denominator (DEN_MAX) keeps the DB trigger's EXACT integer
// cross-multiplication path always reachable (L = LCM of bounded denominators
// stays far inside bigint), so the trigger's numeric-overflow fallback is never
// hit from the API. Owners MUST hold a real share (numerator >= 1 — a 0-share
// owner is invalid, mirroring "owners must have pct > 0"); renters may be 0.
const DEN_MAX = 1_000_000;
const shareEntry = z
  .object({
    ownerId: z.string().uuid(),
    ownershipPct: z.number().min(0).max(100),
    relationship: RelationshipSchema,
    role: z.string().max(50).nullable().optional(),
    // S3b — preferred EXACT share input. When supplied the server persists the
    // fraction verbatim and DERIVES ownershipPct = round(num/den*100, 2). When
    // omitted, the server derives num/den from ownershipPct (num=round(pct*100),
    // den=10000) — pct-only callers keep working (back-compat).
    shareNumerator: z.number().int().min(0).optional(),
    shareDenominator: z.number().int().positive().max(DEN_MAX).optional(),
  })
  .strict()
  .refine((e) => (e.relationship === 'renter' ? e.ownershipPct === 0 : e.ownershipPct > 0), {
    message: 'owners must have ownershipPct > 0; renters must have ownershipPct === 0',
  })
  .refine(
    // Either BOTH fraction parts are present, or NEITHER (pct-only). A lone
    // numerator/denominator is ambiguous.
    (e) => (e.shareNumerator === undefined) === (e.shareDenominator === undefined),
    { message: 'shareNumerator and shareDenominator must be provided together' },
  )
  .refine(
    // An OWNER must hold a real share — its EFFECTIVE numerator (explicit, or
    // derived from pct) must be >= 1. A 0-share owner is invalid (mirrors the
    // pct>0 rule above). Renters may carry a 0 numerator.
    (e) => {
      if (e.relationship !== 'owner') return true;
      const { numerator } = deriveShareFraction(e);
      return numerator >= 1;
    },
    { message: 'owners must hold a share (shareNumerator >= 1)' },
  );

/**
 * Derive the canonical (numerator, denominator) for an ownership entry on
 * WRITE. Prefers an explicit fraction; falls back to deriving from the percent
 * (num = round(pct*100), den = 10000). Mirror of the DB backfill in migration
 * 0065 so the FE/BE and the stored rows agree byte-for-byte.
 */
export function deriveShareFraction(e: {
  ownershipPct: number;
  shareNumerator?: number;
  shareDenominator?: number;
}): { numerator: number; denominator: number } {
  if (e.shareNumerator !== undefined && e.shareDenominator !== undefined) {
    return { numerator: e.shareNumerator, denominator: e.shareDenominator };
  }
  return { numerator: Math.round(e.ownershipPct * 100), denominator: 10000 };
}

/** Derive the 2-decimal compat percent from a fraction (round(num/den*100,2)). */
export function fractionToPct(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 100 * 100) / 100;
}

/** gcd by Euclid (non-negative BigInt inputs). */
function gcdBig(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * Atomic full-set replace for an apartment's active ownerships
 * (PUT /apartments/:id/ownerships). The OWNER rows' EXACT fractions must be
 * EMPTY (clear all / renters only) or sum to exactly 1 — the legal end states
 * the DB trigger enforces. ownerId must be unique within the set. The server
 * ends all current active ownerships and inserts this set in one transaction.
 */
export const SetOwnershipsInput = z
  .object({ owners: z.array(shareEntry).max(50) })
  .strict()
  .refine(
    (v) => {
      // Feature A: only OWNER rows count toward the share invariant (renters
      // are excluded — they carry a 0 share). An owner-less set (empty, or
      // renters only) is the "clear" / no-owner legal end state the DB trigger
      // also allows. This MUST agree with the trigger predicate
      // `... AND relationship = 'owner'`.
      //
      // EXACT FRACTION sum = 1 via INTEGER cross-multiplication — a MIRROR of
      // the DB trigger's exact integer path (NOT a pct epsilon, which would
      // reject a faithful thirds split whose derived pct is 99.99). L = LCM of
      // the owner denominators; require Σ num*(L/den) === L.
      //
      // Computed in BigInt (exact, unbounded): with denominators bounded at
      // DEN_MAX and up to 50 owners, L = LCM of distinct coprime denominators
      // can reach ~1e18 (3 primes near 1e6 → ~1e18), and Σ num*(L/den) can
      // exceed Number.MAX_SAFE_INTEGER (2^53 ≈ 9e15). JS `number` arithmetic
      // would lose precision above 2^53 and could FALSELY ACCEPT a set that does
      // NOT sum to 1, diverging from the trigger (which raises). BigInt is exact
      // across the entire DEN_MAX × 50-owner domain — no overflow, no float —
      // and MIRRORS the trigger's primary integer path exactly.
      const ownerFracs = v.owners
        .filter((o) => o.relationship === 'owner')
        .map((o) => deriveShareFraction(o));
      if (ownerFracs.length === 0) return true; // no owners → cleared state.

      let lcm = 1n;
      for (const { denominator } of ownerFracs) {
        const den = BigInt(denominator);
        lcm = (lcm / gcdBig(lcm, den)) * den;
      }
      const sum = ownerFracs.reduce((a, { numerator, denominator }) => {
        return a + BigInt(numerator) * (lcm / BigInt(denominator));
      }, 0n);
      return sum === lcm;
    },
    { message: 'owner shares must sum to exactly 1 (renters excluded; or be empty to clear)' },
  )
  .refine((v) => new Set(v.owners.map((o) => o.ownerId)).size === v.owners.length, {
    message: 'duplicate ownerId in the set',
  });
export type SetOwnerships = z.infer<typeof SetOwnershipsInput>;

/** Apartment-scoped owner view (docs/09 §3.13 Owner incl. ownership_pct). */
export const ApartmentOwnerSchema = OwnerSchema.extend({
  ownershipId: z.string().uuid(),
  ownershipPct: z.number().min(0).max(100),
  relationship: RelationshipSchema,
  role: z.string().max(50).nullable(),
});
export type ApartmentOwner = z.infer<typeof ApartmentOwnerSchema>;

/** GET list query — cursor pagination only (D.16; never offset). */
export const ListOwnershipsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListOwnershipsQueryDto = z.infer<typeof ListOwnershipsQuery>;
