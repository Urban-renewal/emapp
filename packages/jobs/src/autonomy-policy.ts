/**
 * `AutonomyPolicy` — the guardrail charter AS CODE (Autonomous Master Plan,
 * Phase 0: the SAFETY FLOOR). This module is the single chokepoint that
 * decides, for any action the autonomy engine might take, whether it may
 * `autoExecute`, must be drafted for human one-click confirm (`proposeConfirm`),
 * or is reserved for a human entirely (`humanOnly`).
 *
 * THIS SLICE IS PURE LAW, NOT WIRING. Nothing in production calls `classify()`
 * yet — that is correct for Phase 0. Later phases (the proposal queue, the
 * executor, the OutboundGovernor) adopt this classifier as their gate.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE ONE BOUNDARY (guardrail charter §1 — hard-pinned, no config can bypass):
 *
 *   autoExecute  ⟺  internal AND reversible AND non-PII AND non-outbound
 *
 * Everything outbound / legal / PII-exposing / irreversible is `proposeConfirm`
 * or `humanOnly`. This single rule is what makes "autonomous EMAPP" compatible
 * with legally-binding signatures and national_id PII: the system may DRAFT or
 * PROPOSE anything, but it may EXECUTE unattended only inside this envelope.
 *
 * HUMAN-CONFIRM FLOORS (charter §7 — `humanOnly` regardless of any input):
 *   status→approved · tabu confirm→ownerships · national_id export/erase (RTBF)
 *   · sensitivity-flip ON · role/Owner grant · provider-session freeze ·
 *   the Gate-6 ~750-doc re-encrypt.
 * These are enumerated below as fixed action kinds; their classification is a
 * literal in the table, not a function of any caller-supplied flag. No crafted
 * input can move them off `humanOnly`.
 *
 * Cadence rules (day 0/+3/+7/+14 reminder timing) are deliberately OUT of this
 * slice — they belong to Phase 2 (the OutboundGovernor + cadence policy). Phase
 * 0 is just the classifier + the floors.
 *
 * Dependency-light + FE-safe: this file imports ONLY `zod`. It does NOT import
 * `node:` modules (unlike `mapping-fingerprint.ts`, which uses `node:crypto`),
 * so `@emapp/web` (next.js) can import the taxonomy to render proposal badges
 * without breaking the FE bundle. The package exposes a `./autonomy-policy`
 * subpath export (see package.json `exports`) so the FE imports THIS file
 * directly — `import { classify } from '@emapp/jobs/autonomy-policy'` — never
 * the barrel `index.ts` (which re-exports node-only modules like
 * `mapping-fingerprint`). The BE keeps importing from the package root.
 */
import { z } from 'zod';

/**
 * The three terminal decisions. There is no fourth state: an action that is not
 * provably safe-to-auto is, at minimum, `proposeConfirm`; the highest-stakes
 * acts are `humanOnly` (drafted as evidence, never executed by replay).
 */
export const AutonomyDecisionSchema = z.enum(['autoExecute', 'proposeConfirm', 'humanOnly']);
export type AutonomyDecision = z.infer<typeof AutonomyDecisionSchema>;

/**
 * Rate buckets are named here (so the classifier can hand the executor the
 * right ceiling later) but the actual ceilings + cadence live in Phase 2's
 * OutboundGovernor. `none` = no rate concept (internal reconciliation);
 * `internal` = bounded engine work; the outbound buckets gate real sends.
 */
export const RateBucketSchema = z.enum([
  'none',
  'internal',
  'outbound:email',
  'outbound:sms',
  'outbound:share',
]);
export type RateBucket = z.infer<typeof RateBucketSchema>;

/**
 * The flag vector that THE ONE BOUNDARY is computed from. Every action kind
 * pins these as fixed literals (see ACTION_TABLE) — they are NOT caller-
 * supplied, which is precisely why a crafted input cannot cross the boundary.
 */
export const ActionFlagsSchema = z.object({
  /** false ⇒ the act leaves the system (a send, a disclosure, a share). */
  internal: z.boolean(),
  /** false ⇒ no clean undo (physical delete, one-way disclosure, legal commit). */
  reversible: z.boolean(),
  /** true ⇒ the act reads, exposes, exports, or erases PII (national_id, phone, signature). */
  pii: z.boolean(),
  /** true ⇒ the act sends to a person/external recipient (email/SMS/share). */
  outbound: z.boolean(),
  /** true ⇒ requires owner/tenant consent (opt-out, consent-epoch) before it may run. */
  consentRequired: z.boolean(),
  /** the rate bucket the executor will meter this act against (Phase 2). */
  rateBucket: RateBucketSchema,
});
export type ActionFlags = z.infer<typeof ActionFlagsSchema>;

/**
 * The closed set of action kinds the autonomy engine knows about. New
 * autonomous behaviors MUST add a kind here AND a row to ACTION_TABLE — that
 * is the structural guarantee that nothing slips past the classifier with an
 * undefined classification (`classify` rejects unknown kinds).
 *
 * Grouped by the master-plan producers, but the grouping is documentary only;
 * the classification is per-kind in ACTION_TABLE.
 */
export const AutonomyActionKindSchema = z.enum([
  // ── Safe internal reconciliation (the autoExecute envelope) ───────────────
  'attention.rerank', //            re-rank the fleet attention snapshot
  'proposal.expire', //             flip a stale pending proposal → expired
  'classify.tag.nonSensitive', //   server-side classify of a NON-sensitive doc
  'dedup.autoArchive.exactHash', // archive a byte-identical duplicate (undoable)
  'scan.reReject', //               re-reject a doc that failed an AV/scan re-check
  'breach.throttle.autoExpiring', //auto-expiring brute-force throttle window
  'tabu.parse.toDraft', //          parse a נסח into a DRAFT structure (no commit)
  'signature_request.reissue', //   re-mint a fresh signing link for a LAPSED
  //                                request — INTERNAL (no send) + reversible +
  //                                non-PII. Distinct from `link.reissue.send`
  //                                (which ALSO sends → outbound). By THE ONE
  //                                BOUNDARY this is autoExecute-ELIGIBLE, but
  //                                Phase 1 still PROPOSES it (propose-not-execute);
  //                                the classification states what is permissible,
  //                                the executor decides when to actually run.
  'task.create', //                 G1 TaskWatcher: open a SYSTEM-OWNED task for a
  //                                detected work condition (e.g. a gathering-
  //                                signatures project missing a required doc type).
  //                                INTERNAL (no send) + REVERSIBLE (archive the
  //                                task) + NON-PII (project/doc-type ids only). By
  //                                THE ONE BOUNDARY this is autoExecute-ELIGIBLE,
  //                                but G1 ships PROPOSE-AND-CONFIRM — the producer
  //                                emits a DRAFT and the executor only creates the
  //                                task on the manager's APPROVE (auto-execution is
  //                                a future owner opt-in; same pattern as
  //                                signature_request.reissue above).

  // ── Outbound (always propose-then-confirm; never auto, charter §1) ────────
  'reminder.send', //               a signature-reminder email/SMS to an owner
  'link.reissue.send', //           re-issue + send a fresh signing link
  'share.renew.send', //            renew + notify an external (contractor) share
  'invite.chase.send', //           chase an unaccepted org-user invite
  'tenant.onboard.smsOtp', //       tenant self-onboard SMS OTP
  'document.chase.send', //         S5 DocumentChase: chase the responsible PARTY
  //                                (שמאי/אדריכל/עו״ד/…) for a project's MISSING
  //                                required document. OUTBOUND (a request leaves the
  //                                system to a person) + CONSENT-REQUIRED → by THE ONE
  //                                BOUNDARY this is proposeConfirm, NEVER auto-execute
  //                                (a chase is a send; autoExecute requires
  //                                non-outbound). The executor routes the send through
  //                                governOutboundSend with the REAL recipient consent.

  // ── Human-confirm FLOORS (charter §7 — humanOnly, pinned literals) ────────
  'status.toApproved', //           project status → approved (legal threshold)
  'tabu.confirm.ownerships', //     commit parsed נסח ownerships (legal record)
  'nationalId.export', //           export national_id PII (DSAR / report)
  'nationalId.erase.rtbf', //       right-to-be-forgotten erase (irreversible)
  'sensitivity.flipOn', //          flip a doc's sensitivity ON (turn-on-only)
  'role.grant.owner', //            grant a role / Owner privilege
  'provider.session.freeze', //     freeze a provider session (governance)
  'gate6.docs.reEncrypt', //        the Gate-6 ~750-doc re-encrypt backfill
]);
export type AutonomyActionKind = z.infer<typeof AutonomyActionKindSchema>;

/** The action presented to the classifier: just its kind. The flags + decision
 *  are pinned per-kind in code, NOT carried on the input — so the boundary is a
 *  property of the kind, never of crafted caller state. */
export const AutonomyActionSchema = z.object({ kind: AutonomyActionKindSchema }).strict();
export type AutonomyAction = z.infer<typeof AutonomyActionSchema>;

/** The classifier verdict: the decision plus the boundary-relevant flags. */
export const AutonomyClassificationSchema = z.object({
  decision: AutonomyDecisionSchema,
  reversible: z.boolean(),
  pii: z.boolean(),
  outbound: z.boolean(),
  consentRequired: z.boolean(),
  rateBucket: RateBucketSchema,
});
export type AutonomyClassification = z.infer<typeof AutonomyClassificationSchema>;

/** A row in the pinned table: the fixed flags + the floor decision, if any. */
interface ActionSpec extends ActionFlags {
  /**
   * A hard floor that OVERRIDES the boundary computation. Used only for the
   * charter §7 human-confirm floors, which must be `humanOnly` even though
   * some are technically internal/reversible (e.g. a role grant is internal,
   * but is governance-sensitive and pinned to a human). When `floor` is set,
   * it is the decision verbatim; when absent, THE ONE BOUNDARY decides.
   */
  floor?: AutonomyDecision;
}

/**
 * THE TABLE. Every action kind's fixed flag vector + optional floor. This is
 * the law. To read it: for each row, `deriveDecision` applies THE ONE BOUNDARY
 * unless a `floor` is present (the §7 human-confirm floors).
 *
 * `Record<AutonomyActionKind, …>` makes a missing kind a COMPILE error — the
 * taxonomy can never have an unclassified kind.
 */
const ACTION_TABLE: Record<AutonomyActionKind, ActionSpec> = {
  // ── Safe internal reconciliation → autoExecute by the boundary ────────────
  'attention.rerank': {
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'proposal.expire': {
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'classify.tag.nonSensitive': {
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'dedup.autoArchive.exactHash': {
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'scan.reReject': {
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'breach.throttle.autoExpiring': {
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'tabu.parse.toDraft': {
    // Parse-into-DRAFT only: reversible (the draft can be discarded), internal
    // (no send), and crucially NOT the legal commit (that is
    // `tabu.confirm.ownerships`, a §7 floor below). The parsed text may contain
    // national_id, so `pii: true` — which on its own forces this OFF
    // autoExecute to proposeConfirm. Legal commit stays human; even the draft
    // is confirmed.
    internal: true,
    reversible: true,
    pii: true,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'signature_request.reissue': {
    // Re-mint a fresh signing link for a LAPSED request: INTERNAL (no email/SMS
    // — that is `link.reissue.send`), REVERSIBLE (the request can re-expire /
    // be cancelled), and NON-PII (the link is a bearer token, not national_id;
    // no PII is read or disclosed by the re-mint). By THE ONE BOUNDARY this is
    // autoExecute-ELIGIBLE — but Phase 1 ships propose-not-execute, so the
    // producer emits it as a DRAFT and the executor only runs it on human
    // APPROVE. The classification is the permission ceiling, not the trigger.
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },
  'task.create': {
    // Open a SYSTEM-OWNED task for a detected work condition (G1 TaskWatcher).
    // INTERNAL (no email/SMS leaves the system), REVERSIBLE (archive un-does it),
    // and NON-PII (the title/body + evidence carry project/apartment/doc-type ids
    // and counts only — never owner national_id/phone/name; the executor composes a
    // PII-free, user-framed title). By THE ONE BOUNDARY this is autoExecute-ELIGIBLE
    // — but G1 ships propose-AND-confirm: the producer drafts it and the executor
    // only creates the task on a human APPROVE (auto-execute is a future owner
    // opt-in). The classification is the permission ceiling, not the trigger.
    internal: true,
    reversible: true,
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'internal',
  },

  // ── Outbound → proposeConfirm by the boundary (outbound + consent) ────────
  'reminder.send': {
    internal: false,
    reversible: false,
    pii: false,
    outbound: true,
    consentRequired: true,
    rateBucket: 'outbound:email',
  },
  'link.reissue.send': {
    internal: false,
    reversible: false,
    pii: false,
    outbound: true,
    consentRequired: true,
    rateBucket: 'outbound:email',
  },
  'share.renew.send': {
    internal: false,
    reversible: false,
    pii: false,
    outbound: true,
    consentRequired: true,
    rateBucket: 'outbound:share',
  },
  'invite.chase.send': {
    internal: false,
    reversible: false,
    pii: false,
    outbound: true,
    consentRequired: true,
    rateBucket: 'outbound:email',
  },
  'tenant.onboard.smsOtp': {
    internal: false,
    reversible: false,
    pii: true, // sends to a phone number (PII recipient)
    outbound: true,
    consentRequired: true,
    rateBucket: 'outbound:sms',
  },
  'document.chase.send': {
    // S5 DocumentChase: chase the responsible PARTY for a project's MISSING
    // required document. OUTBOUND (a request — and, when wired, an upload-link
    // share — leaves the system to a person) → by THE ONE BOUNDARY this can NEVER
    // autoExecute (autoExecute requires non-outbound). CONSENT-REQUIRED: the
    // ConsentGate denies if the recipient opted out — the executor resolves the
    // REAL consent state (fail-closed until the opt-out registry + party-recipient
    // resolver land; NEVER hardcoded true — that was the #516 consent-bypass). The
    // chase goes out over email + (X-S6) an external_share upload link, so the rate
    // bucket is the share bucket.
    internal: false,
    reversible: false,
    pii: false, // the proposal/evidence is PII-free (party + type keys only)
    outbound: true,
    consentRequired: true,
    rateBucket: 'outbound:share',
  },

  // ── Human-confirm FLOORS → humanOnly, pinned (charter §7) ─────────────────
  'status.toApproved': {
    internal: true,
    reversible: false, // a legal threshold crossing
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
  'tabu.confirm.ownerships': {
    internal: true,
    reversible: false, // commits the legal ownership record
    pii: true,
    outbound: false,
    consentRequired: false,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
  'nationalId.export': {
    internal: false, // discloses PII out of the system
    reversible: false,
    pii: true,
    outbound: true,
    consentRequired: true,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
  'nationalId.erase.rtbf': {
    internal: true,
    reversible: false, // right-to-be-forgotten is one-way by definition
    pii: true,
    outbound: false,
    consentRequired: false,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
  'sensitivity.flipOn': {
    internal: true,
    reversible: false, // turn-ON-only; tightening access is not auto-loosened
    pii: true,
    outbound: false,
    consentRequired: false,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
  'role.grant.owner': {
    internal: true,
    reversible: true, // a grant CAN be revoked, but governance pins it to human
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
  'provider.session.freeze': {
    internal: true,
    reversible: true, // a freeze can be lifted, but it's a governance act
    pii: false,
    outbound: false,
    consentRequired: false,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
  'gate6.docs.reEncrypt': {
    internal: true,
    reversible: false, // a ~750-doc re-encrypt backfill is not casually undone
    pii: true,
    outbound: false,
    consentRequired: false,
    rateBucket: 'none',
    floor: 'humanOnly',
  },
};

/**
 * THE ONE BOUNDARY, as a pure function of the flags. `autoExecute` iff
 * internal AND reversible AND non-PII AND non-outbound. Anything else that is
 * not a §7 floor lands on `proposeConfirm` (it can be DRAFTED and one-click
 * confirmed). A `floor` (§7) overrides this entirely.
 *
 * Exported so tests (and future reviewers) can assert the boundary directly,
 * independent of the table.
 */
export function deriveDecision(flags: ActionFlags, floor?: AutonomyDecision): AutonomyDecision {
  if (floor) return floor;
  const safeToAuto = flags.internal && flags.reversible && !flags.pii && !flags.outbound;
  return safeToAuto ? 'autoExecute' : 'proposeConfirm';
}

/**
 * Classify an action into its terminal decision + boundary flags.
 *
 * The input is parsed with Zod (`.strict()`), so a malformed or unknown action
 * throws rather than silently defaulting to a permissive decision — fail-closed.
 * The flags and decision come ENTIRELY from the pinned ACTION_TABLE, never from
 * the caller, so no crafted input can cross THE ONE BOUNDARY or move a §7 floor
 * off `humanOnly`.
 */
export function classify(action: AutonomyAction): AutonomyClassification {
  const { kind } = AutonomyActionSchema.parse(action);
  const spec = ACTION_TABLE[kind];
  const decision = deriveDecision(spec, spec.floor);
  return {
    decision,
    reversible: spec.reversible,
    pii: spec.pii,
    outbound: spec.outbound,
    consentRequired: spec.consentRequired,
    rateBucket: spec.rateBucket,
  };
}

/** All known action kinds — useful for exhaustive tests + future UI badges. */
export const ALL_AUTONOMY_ACTION_KINDS = AutonomyActionKindSchema.options;
