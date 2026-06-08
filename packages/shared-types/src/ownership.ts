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
  relationship: RelationshipSchema,
  role: z.string().max(50).nullable(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Ownership = z.infer<typeof OwnershipSchema>;

// Per-entry shape for the atomic set-replace. The pct↔relationship rule
// (owner ⇒ pct > 0, renter ⇒ pct === 0) is enforced by the refine below so
// the in-app 400 agrees with the DB CHECK + trigger backstop. `ownershipPct`
// itself is relaxed to `min(0)` (was `gt(0)`) to admit the renter's 0.
const shareEntry = z
  .object({
    ownerId: z.string().uuid(),
    ownershipPct: z.number().min(0).max(100),
    relationship: RelationshipSchema,
    role: z.string().max(50).nullable().optional(),
  })
  .strict()
  .refine((e) => (e.relationship === 'renter' ? e.ownershipPct === 0 : e.ownershipPct > 0), {
    message: 'owners must have ownershipPct > 0; renters must have ownershipPct === 0',
  });

const SUM_EPSILON = 0.001;

/**
 * Atomic full-set replace for an apartment's active ownerships
 * (PUT /apartments/:id/ownerships). `owners` must be EMPTY (clear all) or
 * sum to exactly 100 (the locked trigger's only legal end states);
 * ownerId must be unique within the set. The server ends all current
 * active ownerships and inserts this set in one transaction.
 */
export const SetOwnershipsInput = z
  .object({ owners: z.array(shareEntry).max(50) })
  .strict()
  .refine(
    (v) => {
      // Feature A: only OWNERS count toward the 100% invariant (renters are
      // excluded — they carry pct 0). An owner-less set (empty, or renters
      // only) sums to 0, which is the "clear" / no-owner legal end state the
      // DB trigger also allows (v_total > 0 guard). This MUST agree with the
      // trigger predicate `... AND relationship = 'owner'`.
      const ownerSum = v.owners
        .filter((o) => o.relationship === 'owner')
        .reduce((a, o) => a + o.ownershipPct, 0);
      if (ownerSum === 0) return true;
      return Math.abs(ownerSum - 100) <= SUM_EPSILON;
    },
    { message: 'owner shares must sum to exactly 100 (renters excluded; or be empty to clear)' },
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
