import { z } from 'zod';

/**
 * Slice 2.5 — OWNER LEGAL / LIFE STATES (`owner_states` table, migration 0084).
 *
 * An OWNER may carry one or more legal/life conditions that change how the org
 * must treat them in the signature-collection process — a competency issue (the
 * owner has a guardian / אפוטרופוס), an ownership dispute, a transfer in flight,
 * a lien (עיקול / שעבוד), an identity that needs verification, or a withdrawal of
 * processing-consent. These are NOT the owner's identity (that lives on `owners`)
 * — they are facts ABOUT the owner's standing that the manager records and the
 * autonomous loop perceives.
 *
 * ── PII DISCIPLINE (the load-bearing rule of this slice) ─────────────────────
 * Guardian identity (אפוטרופוס name / phone / national_id) is PII. It is stored
 * pgcrypto-encrypted at rest (`guardian_*_encrypted bytea`, key PII_ENCRYPTION_KEY,
 * mirroring `owners.national_id_encrypted`) and NEVER returned in cleartext on the
 * wire — the view returns a MASKED guardian label only. It is NEVER logged and
 * NEVER placed in proposal evidence / audit afterState. The perception facet is
 * COUNTS ONLY (no names, no guardian PII): the `.strict()` schema is the structural
 * guard that no name can be smuggled onto the count shape.
 *
 * This file is the SINGLE source of truth for the owner-state contract — the BE
 * DTOs re-export from here; the FE imports the inferred types.
 */

/**
 * The KIND of owner legal/life state. Closed set — enforced Zod-at-edge AND a
 * belt-and-suspenders DB CHECK (migration 0084). Additive: a new kind appends
 * here + the CHECK.
 *  - `competency`         — the owner lacks legal capacity; a guardian
 *                           (אפוטרופוס) acts for them. Carries guardian PII.
 *  - `dispute`            — an ownership dispute (סכסוך בעלות) is open — the
 *                           owner's consent is contested / blocking.
 *  - `transfer`           — an ownership transfer (העברת זכויות) is in flight —
 *                           the legal owner-of-record may be changing.
 *  - `lien`               — a lien / attachment (עיקול / שעבוד) encumbers the
 *                           owner's rights in the apartment.
 *  - `verify`             — the owner's identity / standing needs verification
 *                           before their signature can be relied on.
 *  - `consent_withdrawal` — the owner withdrew processing-consent (a standing
 *                           fact tracked alongside the outbound opt-out machinery).
 */
export const OwnerStateKindEnum = z.enum([
  'competency',
  'dispute',
  'transfer',
  'lien',
  'verify',
  'consent_withdrawal',
]);
export type OwnerStateKind = z.infer<typeof OwnerStateKindEnum>;

/** Every kind value in declaration order — totality helpers (FE/BE/specs). */
export const ALL_OWNER_STATE_KINDS: readonly OwnerStateKind[] = OwnerStateKindEnum.options;

/**
 * The lifecycle status of an owner-state. A state is `active` while it bears on
 * the process; the manager `resolved`s it once the underlying matter is closed.
 * (There is no hard DELETE — resolve is a status transition; archive = the
 * standard `archivedAt` soft-delete.)
 */
export const OwnerStateStatusEnum = z.enum(['active', 'resolved']);
export type OwnerStateStatus = z.infer<typeof OwnerStateStatusEnum>;

/**
 * Which kinds BLOCK an owner's consent — i.e. an active state of one of these
 * kinds means the owner is counted in the consent threshold but cannot legitimately
 * sign yet (a competency issue or an open dispute). The `ownership-mismatch-flag`
 * recommender keys off exactly this set. Kept here, once, so the FE badge styling,
 * the BE recommender, and any spec agree by construction.
 */
export const BLOCKING_OWNER_STATE_KINDS: readonly OwnerStateKind[] = ['competency', 'dispute'];

/**
 * The wire view of an owner-state. PII-DISCIPLINED: `guardianNameMasked` is the
 * ONLY guardian identity field, and it is ALWAYS masked (e.g. "א***" / null when
 * no guardian) — the cleartext guardian name/phone/national_id NEVER crosses the
 * wire (no reveal endpoint is exposed in this slice). `subKind` is an optional
 * free-text refinement (e.g. a court reference label) — NOT PII (the caller is
 * responsible for not putting PII there; the create DTO bounds its length).
 */
export const OwnerStateViewSchema = z
  .object({
    id: z.string().uuid(),
    ownerId: z.string().uuid(),
    kind: OwnerStateKindEnum,
    /** Optional non-PII refinement label (a sub-type / short reference). */
    subKind: z.string().nullable(),
    status: OwnerStateStatusEnum,
    /** MASKED guardian identity only — never cleartext. Null when no guardian. */
    guardianNameMasked: z.string().nullable(),
    /** Whether a guardian contact (phone) is on file — a boolean, never the value. */
    hasGuardianContact: z.boolean(),
    /** Whether this kind blocks the owner's consent (competency | dispute). */
    isBlocking: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    resolvedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type OwnerStateView = z.infer<typeof OwnerStateViewSchema>;

/**
 * Create an owner-state. Guardian fields are OPTIONAL and only meaningful for
 * `competency` (a guardian acts for the owner) — they are accepted for any kind
 * but the FE only collects them for competency. Guardian PII is encrypted at the
 * BE before storage; it never round-trips back in cleartext.
 *
 * `subKind` is bounded free-text (a short reference / sub-type) — the caller MUST
 * NOT place PII there; the length bound keeps it a label, not a payload.
 */
export const CreateOwnerStateSchema = z
  .object({
    kind: OwnerStateKindEnum,
    subKind: z.string().trim().min(1).max(80).optional(),
    /** Guardian display name (PII — encrypted at rest, never returned cleartext). */
    guardianName: z.string().trim().min(1).max(120).optional(),
    /** Guardian contact phone (PII — encrypted at rest, never returned cleartext). */
    guardianPhone: z.string().trim().min(3).max(40).optional(),
    /** Guardian national_id (PII — encrypted at rest, never returned cleartext). */
    guardianNationalId: z.string().trim().min(3).max(40).optional(),
  })
  .strict();
export type CreateOwnerState = z.infer<typeof CreateOwnerStateSchema>;

/**
 * PII-FREE perception counts for the owner-state dimension — the situation-picture
 * facet. COUNTS ONLY: no names, no guardian PII. The `.strict()` posture is the
 * structural guard that no identity field can be smuggled onto the shape. Single-
 * sourced with the canonical owner read in `computeOrgStats`.
 *
 *  - `ownersWithActiveLegalState` — distinct owners with ≥1 active, non-archived
 *                                   owner-state of ANY kind.
 *  - `deceasedCount`              — active `competency` states (the closest modelled
 *                                   "owner can no longer sign for themselves" family;
 *                                   the field name is kept generic per the brief's
 *                                   perception contract — see migration note).
 *  - `disputedCount`             — active `dispute` states.
 *  - `lienCount`                 — active `lien` states.
 *  - `unverifiedCount`           — active `verify` states.
 *  - `consentWithdrawnCount`     — active `consent_withdrawal` states.
 */
export const OwnerStateCountsSchema = z
  .object({
    ownersWithActiveLegalState: z.number().int().nonnegative(),
    deceasedCount: z.number().int().nonnegative(),
    disputedCount: z.number().int().nonnegative(),
    lienCount: z.number().int().nonnegative(),
    unverifiedCount: z.number().int().nonnegative(),
    consentWithdrawnCount: z.number().int().nonnegative(),
  })
  .strict();
export type OwnerStateCounts = z.infer<typeof OwnerStateCountsSchema>;
