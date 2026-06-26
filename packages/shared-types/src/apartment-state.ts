import { z } from 'zod';

/**
 * Slice 2.7 — APARTMENT LEGAL / LIFE STATES (`apartment_states` table, migration 0086).
 *
 * The structural MIRROR of `owner-state.ts` (2.5), adapted to APARTMENTS. An apartment
 * may carry one or more legal/life conditions that change how the org must treat the
 * unit in the signature-collection process — a deceased registered owner, an ownership
 * dispute, a power of attorney acting on the unit, an eviction in flight, outstanding
 * repairs, or a transfer of rights. These are NOT the apartment's identity (that lives
 * on `apartments`) and NOT the D.18-locked `apartment_status` — they are facts ABOUT
 * the unit's standing that the manager records and the autonomous loop perceives.
 *
 * ── NO PII (the load-bearing rule of THIS slice) ────────────────────────────
 * Unlike owner-states (encrypted guardian PII), apartment-states carry NO
 * national_id / phone / contact / person identity. A state that conceptually
 * references a person (deceased / poa) captures it ONLY as the `kind` / `subKind`
 * enum + a bounded non-PII `note` label. There is NO encrypted column, NO contact
 * column, and NO reveal endpoint — a person involved is an `owner` / `owner_state`,
 * never carried here. The perception facet is COUNTS ONLY: the `.strict()` schema is
 * the structural guard that nothing identity-shaped can be smuggled onto the count.
 *
 * This file is the SINGLE source of truth for the apartment-state contract — the BE
 * DTOs re-export from here; the FE imports the inferred types.
 */

/**
 * The KIND of apartment legal/life state. Closed set — enforced Zod-at-edge AND a
 * belt-and-suspenders DB enum/CHECK (migration 0086). Additive: a new kind appends
 * here + the enum.
 *  - `deceased`        — a registered owner of the unit is deceased; the rights pass
 *                        to an estate / heirs before a binding signature.
 *  - `dispute`         — an ownership / boundary dispute (סכסוך) is open over the unit.
 *  - `poa`             — the unit is acted on under a power of attorney (ייפוי כוח).
 *  - `eviction`        — an eviction / tenancy-removal (פינוי) is in flight.
 *  - `repairs`         — outstanding structural repairs / defects (ליקויים) block use.
 *  - `rights_transfer` — a transfer of rights in the unit (העברת זכויות) is in flight.
 */
export const ApartmentStateKindEnum = z.enum([
  'deceased',
  'dispute',
  'poa',
  'eviction',
  'repairs',
  'rights_transfer',
]);
export type ApartmentStateKind = z.infer<typeof ApartmentStateKindEnum>;

/** Every kind value in declaration order — totality helpers (FE/BE/specs). */
export const ALL_APARTMENT_STATE_KINDS: readonly ApartmentStateKind[] =
  ApartmentStateKindEnum.options;

/**
 * The lifecycle status of an apartment-state. A state is `active` while it bears on
 * the process; the manager `resolved`s it once the underlying matter is closed.
 * (There is no hard DELETE — resolve is a status transition; archive = the standard
 * `archivedAt` soft-delete.)
 */
export const ApartmentStateStatusEnum = z.enum(['active', 'resolved']);
export type ApartmentStateStatus = z.infer<typeof ApartmentStateStatusEnum>;

/**
 * Which kinds BLOCK the apartment's progress toward a binding signature — an active
 * state of one of these kinds means the unit cannot legitimately complete the
 * signature process yet (a deceased owner, an open dispute, or an eviction in
 * flight). The `apartment-blocker-flag` recommender keys off exactly this set. Kept
 * here, once, so the FE badge styling, the BE recommender, and any spec agree by
 * construction.
 */
export const BLOCKING_APARTMENT_STATE_KINDS: readonly ApartmentStateKind[] = [
  'deceased',
  'dispute',
  'eviction',
];

/**
 * The wire view of an apartment-state. PII-FREE: `subKind` + `note` are optional
 * non-PII labels (the caller is responsible for not putting PII there; the create
 * DTO bounds their length). There is NO person/contact field of any kind.
 */
export const ApartmentStateViewSchema = z
  .object({
    id: z.string().uuid(),
    apartmentId: z.string().uuid(),
    kind: ApartmentStateKindEnum,
    /** Optional non-PII refinement label (a sub-type / short reference). */
    subKind: z.string().nullable(),
    /** Optional bounded non-PII note (a short description / court reference). */
    note: z.string().nullable(),
    status: ApartmentStateStatusEnum,
    /** Whether this kind blocks the unit's signature (deceased | dispute | eviction). */
    isBlocking: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ApartmentStateView = z.infer<typeof ApartmentStateViewSchema>;

/**
 * Create an apartment-state. `subKind` + `note` are bounded free-text (a short
 * reference / sub-type / description) — the caller MUST NOT place PII there; the
 * length bounds keep them labels, not payloads. There are NO person/contact fields.
 */
export const CreateApartmentStateSchema = z
  .object({
    kind: ApartmentStateKindEnum,
    subKind: z.string().trim().min(1).max(80).optional(),
    note: z.string().trim().min(1).max(280).optional(),
  })
  .strict();
export type CreateApartmentState = z.infer<typeof CreateApartmentStateSchema>;

/**
 * PII-FREE perception counts for the apartment-state dimension — the situation-
 * picture facet. COUNTS ONLY. The `.strict()` posture is the structural guard that
 * no identity field can be smuggled onto the shape. Single-sourced with the canonical
 * apartment-state read in `computeOrgStats`.
 *
 *  - `apartmentsWithLegalState` — distinct apartments with ≥1 active, non-archived
 *                                 apartment-state of ANY kind.
 *  - `evictionCount`            — active `eviction` states.
 *  - `disputeCount`             — active `dispute` states.
 *  - `repairsCount`             — active `repairs` states.
 *  - `rightsTransferCount`      — active `rights_transfer` states.
 */
export const ApartmentStateCountsSchema = z
  .object({
    apartmentsWithLegalState: z.number().int().nonnegative(),
    evictionCount: z.number().int().nonnegative(),
    disputeCount: z.number().int().nonnegative(),
    repairsCount: z.number().int().nonnegative(),
    rightsTransferCount: z.number().int().nonnegative(),
  })
  .strict();
export type ApartmentStateCounts = z.infer<typeof ApartmentStateCountsSchema>;
