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

export const OwnershipSchema = z.object({
  id: z.string().uuid(),
  apartmentId: z.string().uuid(),
  ownerId: z.string().uuid(),
  ownershipPct: z.number().min(0).max(100),
  role: z.string().max(50).nullable(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Ownership = z.infer<typeof OwnershipSchema>;

const shareEntry = z
  .object({
    ownerId: z.string().uuid(),
    ownershipPct: z.number().gt(0).max(100),
    role: z.string().max(50).nullable().optional(),
  })
  .strict();

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
      if (v.owners.length === 0) return true;
      const sum = v.owners.reduce((a, o) => a + o.ownershipPct, 0);
      return Math.abs(sum - 100) <= SUM_EPSILON;
    },
    { message: 'ownership shares must sum to exactly 100 (or be empty to clear)' },
  )
  .refine((v) => new Set(v.owners.map((o) => o.ownerId)).size === v.owners.length, {
    message: 'duplicate ownerId in the set',
  });
export type SetOwnerships = z.infer<typeof SetOwnershipsInput>;

/** Apartment-scoped owner view (docs/09 §3.13 Owner incl. ownership_pct). */
export const ApartmentOwnerSchema = OwnerSchema.extend({
  ownershipId: z.string().uuid(),
  ownershipPct: z.number().min(0).max(100),
  role: z.string().max(50).nullable(),
});
export type ApartmentOwner = z.infer<typeof ApartmentOwnerSchema>;

/** GET list query — cursor pagination only (D.16; never offset). */
export const ListOwnershipsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListOwnershipsQueryDto = z.infer<typeof ListOwnershipsQuery>;
