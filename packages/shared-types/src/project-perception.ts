import { AutonomyActionKindSchema, type AutonomyActionKind } from '@emapp/jobs';
import { z } from 'zod';

import { ConsentBasisEnum } from './project';

/**
 * `ProjectPerception` — the ONE PII-FREE, per-project read-model that the
 * autonomous-managing loop PERCEIVES from (blueprint wave 1.1). It is assembled
 * (in `@emapp/db` `assembleProjectPerception`) by COMPOSING the existing
 * canonical seams — `projectSetSignatureDocIdsSql` (signatures), the
 * `computeConsentAggregates` CTE shape (consent), the `detectMissingRequiredDocs`
 * CTE (missing docs), and `PROJECT_TERMINAL_STATUSES` (terminal/at-risk) — and
 * INVENTS NO NEW FACT: every field is a count, a derived %, an id, a timestamp,
 * or an enum. No owner name / national_id / phone / signature is ever read or
 * returned.
 *
 * WHY a shared type at all (single source of truth, owner 2026-06-23): the home
 * KPI, the boards, the recommender fleet, and the cross-party view will ALL read
 * THIS object — never a second, drifting signature/consent/missing-doc query.
 * Defining the contract once, here, is what lets the FE board and the BE
 * recommenders agree by construction (the divergence class we are killing).
 *
 * This slice ships the TYPE + the assembler + the AttentionReason→ActionKind map
 * only. Consumers (`signaturePulse`, `computeOrgStats`, the recommenders) are
 * wired onto it in the NEXT slice — this file invents the substrate, it does not
 * yet replace any existing reader.
 *
 * IMPORT NOTE: this file imports `AutonomyActionKind` from `@emapp/jobs` (a leaf
 * package — zod only, no `@emapp/*` deps), needed for the typed
 * `attentionReasonToActionKind` map. `@emapp/jobs → @emapp/shared-types` does NOT
 * exist, so there is no import cycle. This is a deliberate, documented exception
 * to shared-types' "no `@emapp/*` imports" rule (whose intent is cycle-avoidance,
 * which is preserved) — it is what keeps the map SINGLE-SOURCE against the real
 * kind taxonomy instead of a string mirror that would drift.
 */

/**
 * One MISSING required-document gap on the project (PII-free taxonomy key). The
 * `track` is the checklist track the required-set was chosen for; `docType` is
 * the required document TYPE the project is still missing. Mirrors the
 * `MissingRequiredDocRow` the canonical `detectMissingRequiredDocs` CTE emits —
 * scoped here to the single project (the assembler runs the same CTE shape).
 */
export const PerceptionMissingDocSchema = z
  .object({
    /** The checklist track the required-set was chosen for ('tama38' | …). */
    track: z.string(),
    /** The required document TYPE the project is still missing (taxonomy key). */
    docType: z.string(),
  })
  .strict();
export type PerceptionMissingDoc = z.infer<typeof PerceptionMissingDocSchema>;

/**
 * The signature facet — straight from the canonical signature seams. `signed` /
 * `pending` are the SAME counts `signatureProgressByProject` returns (active,
 * non-archived doc scope, D.57); `consentedPct` / `metThreshold` are the SAME
 * share-weighted aggregate the per-project board renders (single-source with
 * `computeConsentAggregates`); `basis` labels the percent. NO owner identity.
 */
export const PerceptionSignaturesSchema = z
  .object({
    signed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    totalApartments: z.number().int().nonnegative(),
    /** Fully-consented apartments (display count; not the basis of consentedPct). */
    apartmentsConsented: z.number().int().nonnegative(),
    /** Share-weighted consent %, single-source with the per-project board. */
    consentedPct: z.number().int().min(0).max(100),
    /** The project's legal consent target; null when unset. */
    targetSignaturePct: z.number().min(0).max(100).nullable(),
    /** `targetSignaturePct != null && consentedPct >= targetSignaturePct`. */
    metThreshold: z.boolean(),
    /** The computation basis for `consentedPct` (drives the mandatory FE label). */
    basis: ConsentBasisEnum,
  })
  .strict();
export type PerceptionSignatures = z.infer<typeof PerceptionSignaturesSchema>;

/**
 * The signature-ACTIVITY facet — derived from `signature_requests` joined to the
 * project's signature documents (the SAME doc scope as the counts). Timestamps
 * are ISO UTC; staleness is whole-days. NO PII.
 */
export const PerceptionActivitySchema = z
  .object({
    /** ISO UTC of the most-recent SIGNED request on a project doc; null if none. */
    lastSignatureAt: z.string().datetime({ offset: true }).nullable(),
    /** ISO UTC of the OLDEST still-pending request; null when none pending. The
     *  age of this drives the `signature-stalled` recommender downstream. */
    oldestPendingAt: z.string().datetime({ offset: true }).nullable(),
    /** Whole days since `oldestPendingAt`; null when nothing is pending. */
    oldestPendingAgeDays: z.number().int().nonnegative().nullable(),
    /** ISO UTC of the SOONEST-expiring pending request; null when none pending. */
    nextExpiryAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type PerceptionActivity = z.infer<typeof PerceptionActivitySchema>;

/**
 * The HOLDOUT facet — PII-FREE counts only (the named "who's stuck" list stays
 * behind the view_owner_pii gate on its own endpoint; perception never reads a
 * name). `activeOwners` is every active owner of the project's apartments;
 * `unsignedOwners` is how many of them have no SIGNED request — the count of
 * load-bearing holdouts. Both are ids-aggregated to a number, never a name.
 */
export const PerceptionHoldoutsSchema = z
  .object({
    activeOwners: z.number().int().nonnegative(),
    unsignedOwners: z.number().int().nonnegative(),
  })
  .strict();
export type PerceptionHoldouts = z.infer<typeof PerceptionHoldoutsSchema>;

/**
 * The full per-project perception. ONE row per NON-TERMINAL project (terminal
 * deals are excluded by the assembler — `PROJECT_TERMINAL_STATUSES`). Every
 * field is a count / % / id / timestamp / enum; the `.strict()` posture rejects
 * any stray field, which is also the structural guard that no PII column can be
 * smuggled onto the shape.
 */
export const ProjectPerceptionSchema = z
  .object({
    projectId: z.string().uuid(),
    /** The project's own name (its own label, not PII). */
    projectName: z.string(),
    /** Raw `projects.type` enum value (e.g. 'tama38_1'). */
    projectType: z.string(),
    /** Raw `projects.status` enum value (always a NON-terminal value here). */
    status: z.string(),
    /** Always false on a returned row (terminal projects are excluded), carried
     *  so a consumer can assert the invariant without re-deriving it. */
    isTerminal: z.boolean(),
    /** ISO UTC the project was archived; null for the live projects perceived. */
    archivedAt: z.string().datetime({ offset: true }).nullable(),
    signatures: PerceptionSignaturesSchema,
    activity: PerceptionActivitySchema,
    holdouts: PerceptionHoldoutsSchema,
    /** Every missing required-doc gap (taxonomy keys only). */
    missingRequiredDocs: z.array(PerceptionMissingDocSchema),
    /**
     * Composite ANTICIPATE flag — the project is at risk: it is stalled (an old
     * pending request) AND has stagnant consent below target AND is missing at
     * least one required doc. A pure perception (no action), surfaced as a badge.
     */
    atRisk: z.boolean(),
  })
  .strict();
export type ProjectPerception = z.infer<typeof ProjectPerceptionSchema>;

/**
 * AttentionReason — the closed taxonomy of WHY a project needs attention, as
 * READ FROM a `ProjectPerception`. Each reason is a DERIVED condition over the
 * perception fields; the assembler/recommenders map a project to zero-or-more of
 * these. This is the DECIDE-leg vocabulary that sits between perception and the
 * `AutonomyActionKind` boundary.
 *
 * Kept deliberately small + composable — a reason is a fact about the project's
 * state, NOT an action. The action (if any) is resolved through the
 * `attentionReasonToActionKind` map below.
 */
export const AttentionReasonSchema = z.enum([
  /** pending>0 ∧ oldest pending request is older than the stall threshold. */
  'signature_stalled',
  /** a pending request lapses soon (within the expiring-soon window). */
  'signature_expiring',
  /** one or more active owners have not signed (load-bearing holdout). */
  'holdout_blocking',
  /** the project is missing at least one required document type. */
  'missing_required_doc',
  /** consent crossed target while still gathering — ready to surface →approved. */
  'ready_for_approval',
  /** composite risk badge (stalled ∧ stagnant-consent ∧ missing-docs). */
  'at_risk',
  /** healthy / on-track — nothing needs the manager (a pure situational tag). */
  'on_track',
]);
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

/** Every AttentionReason value, in declaration order (totality test helper). */
export const ALL_ATTENTION_REASONS: readonly AttentionReason[] = AttentionReasonSchema.options;

/**
 * THE DECIDE→ACT bridge: each `AttentionReason` maps to the ONE
 * `AutonomyActionKind` it would drive — or `null` when the reason is
 * PERCEIVE-ONLY (a situational badge with no action, per the blueprint's
 * adversarial correction P1-1). `null` is a FIRST-CLASS value here: forcing
 * every reason to name a kind would pressure inventing junk kinds just to
 * satisfy totality — exactly the boundary-table sprawl the engine is meant to
 * prevent. So the value type is `AutonomyActionKind | null`, and the totality
 * over `AttentionReason` is what the `Record<>` compile-checks.
 *
 * NOTE on the mapped KINDS vs the eventual classify() verdict: this map names
 * the kind a reason would emit; whether that kind auto-executes or proposes is
 * decided SOLELY by `classify()` reading `ACTION_TABLE` — never here. (e.g.
 * `ready_for_approval` is SURFACED as work via the existing `task.create` kind —
 * the humanOnly `status.toApproved` FLOOR is never auto-promoted, and the
 * dedicated `status.toApproved.propose` kind lands in the recommender slice;
 * documented here, not guessed.)
 *
 * `Record<AttentionReason, …>` makes a NEW reason without a decision a COMPILE
 * error — the taxonomy can never carry an unmapped reason.
 */
export const attentionReasonToActionKind: Record<AttentionReason, AutonomyActionKind | null> = {
  // A project-level stall → a reminder send (outbound; classify→proposeConfirm).
  signature_stalled: 'reminder.send',
  // A lapsing request → re-mint a fresh link (internal; classify→autoExecute-eligible).
  signature_expiring: 'signature_request.reissue',
  // A load-bearing holdout → open a system task to chase it (internal, reversible).
  holdout_blocking: 'task.create',
  // A missing required doc → open a system task to chase the paperwork (G1 kind).
  missing_required_doc: 'task.create',
  // Ready-for-approval is SURFACED as work today (the humanOnly status floor is
  // never auto-promoted); the dedicated propose-kind lands in the recommender slice.
  ready_for_approval: 'task.create',
  // PERCEIVE-ONLY badges — no action; null is the correct, non-junk mapping.
  at_risk: null,
  on_track: null,
};

/**
 * Guard the map's totality at runtime too (belt-and-braces with the compile-time
 * `Record<>` check): returns the mapped kind, or null for perceive-only reasons.
 */
export function actionKindForAttentionReason(reason: AttentionReason): AutonomyActionKind | null {
  return attentionReasonToActionKind[reason];
}

/** The mapped kinds (excluding the null perceive-only reasons) — a convenience
 *  for consumers that want the set of kinds the perception can drive. Each is
 *  asserted to be a REAL `AutonomyActionKind` (the schema membership check), so
 *  a typo in the map cannot leak a non-kind into this set. */
export const ATTENTION_DRIVEN_ACTION_KINDS: readonly AutonomyActionKind[] = Object.values(
  attentionReasonToActionKind,
).filter(
  (k): k is AutonomyActionKind => k !== null && AutonomyActionKindSchema.options.includes(k),
);
