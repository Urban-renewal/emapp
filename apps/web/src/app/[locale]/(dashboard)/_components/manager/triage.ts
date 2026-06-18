import type { ProjectViewModel } from '@/models/project.vm';

/**
 * Home mission-control triage — PURE, client-side derivation over the
 * project list the home already fetches (E2.1, docs/DESIGN-NORTH-STAR.md).
 *
 * NORTH-STAR honesty rule (principle 4 + "What this is NOT"): every signal
 * here is computed from REAL wire fields on `ProjectListItem`
 * (status / targetConsentPct / unitsCount / signaturesSignedCount /
 * signaturesPendingCount). We NEVER fabricate. Two signals the design wants
 * are deliberately OMITTED because the wire doesn't carry them yet:
 *
 *   - "no movement for X days" (momentum-stall duration) — the project list
 *     row has NO last-signature / last-activity timestamp (only `createdAt`).
 *     We therefore surface stall ONLY as a STATE ("collection not started" =
 *     gathering with zero signatures), never as a fabricated day count.
 *   - the human "why" (owner objection reason / "3 בעלים מתנגדים") — needs a
 *     backend field that does not exist. OMITTED; flagged as the E2 backend
 *     follow-up. See DESIGN-NORTH-STAR.md "Backend follow-ups".
 *
 * Progress is framed in APARTMENTS (the unit the consent threshold and the
 * signature-progress board both use): `signed` = `signaturesSignedCount`,
 * `total` = `unitsCount`. The legal gate is `ceil(targetConsentPct% * total)`
 * signed apartments. We only compute a numeric gate when BOTH a target and a
 * positive apartment count are present; otherwise the project still triages by
 * STATE but carries no fabricated numbers.
 */

/** How close (in apartments) "near the threshold" reaches below the gate. */
export const NEAR_THRESHOLD_WINDOW = 2;

/** A project's standing relative to its legal consent gate. */
export type TriageKind =
  | 'past_threshold' // signed >= gate — the legal majority is reached
  | 'near_threshold' // within NEAR_THRESHOLD_WINDOW signed apartments of the gate
  | 'not_started' // gathering signatures but zero signed yet (a STATE, not a duration)
  | 'in_progress' // gathering, some signed, but not near the gate
  | 'completed' // status === 'completed'
  | 'pre_collection' // planning / approved / in_construction (no active collection)
  | 'cancelled';

export interface ProjectTriage {
  project: ProjectViewModel;
  kind: TriageKind;
  /** Signed apartments (real `signaturesSignedCount`) — null when the wire omits it. */
  signed: number | null;
  /** Total apartments (real `unitsCount`) — null when the wire omits it. */
  total: number | null;
  /** Signed apartments needed to reach the legal gate — null when unknowable. */
  gate: number | null;
  /** Apartments still missing to reach the gate (>=0) — null when unknowable. */
  remainingToGate: number | null;
  /**
   * Urgency rank for ordering (LOWER = more urgent / surfaced first).
   * near-threshold and not-started lead; completed / cancelled sink.
   */
  rank: number;
  /** Whether this project belongs in the "needs you now" exception list. */
  isException: boolean;
}

const RANK: Record<TriageKind, number> = {
  near_threshold: 0,
  not_started: 1,
  in_progress: 2,
  past_threshold: 3,
  pre_collection: 4,
  completed: 5,
  cancelled: 6,
};

/**
 * Derive a single project's triage standing. Pure; no I/O.
 *
 * The numeric gate is computed only when a positive apartment count AND a
 * target percentage are both present (`Number.isFinite`), so a legacy project
 * with `targetConsentPct === null` or a project the BE didn't enrich with
 * counts degrades to a STATE-only classification with null numerics — honest,
 * never guessed.
 */
export function deriveProjectTriage(project: ProjectViewModel): ProjectTriage {
  const total = typeof project.unitsCount === 'number' ? project.unitsCount : null;
  const signed =
    typeof project.signaturesSignedCount === 'number' ? project.signaturesSignedCount : null;
  const targetPct = project.targetConsentPct;

  const hasCounts = total !== null && signed !== null && total > 0;
  const gate =
    hasCounts && typeof targetPct === 'number'
      ? Math.min(total, Math.ceil((targetPct / 100) * total))
      : null;
  const remainingToGate = gate !== null && signed !== null ? Math.max(0, gate - signed) : null;

  const kind = classify(project.status, signed, gate, remainingToGate);

  return {
    project,
    kind,
    signed,
    total,
    gate,
    remainingToGate,
    rank: RANK[kind],
    // Exceptions = the few that need a human now: about to cross the gate, or
    // an active collection that hasn't moved off zero. past-threshold is a
    // WIN (surfaced in "needs a look", celebrated, but not an alarm).
    isException: kind === 'near_threshold' || kind === 'not_started',
  };
}

function classify(
  status: ProjectViewModel['status'],
  signed: number | null,
  gate: number | null,
  remainingToGate: number | null,
): TriageKind {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return 'completed';
  // Only `gathering_signatures` is an ACTIVE collection; the others are
  // pre/post-collection states with no signature urgency on the home.
  if (status !== 'gathering_signatures') return 'pre_collection';

  if (gate !== null && signed !== null && remainingToGate !== null) {
    if (signed >= gate) return 'past_threshold';
    if (remainingToGate <= NEAR_THRESHOLD_WINDOW) return 'near_threshold';
  }
  // No usable gate, or gate present but far: distinguish "not yet started"
  // (zero signed — a real STATE) from "in progress".
  if (signed === 0) return 'not_started';
  return 'in_progress';
}

export interface OrgPulse {
  /** Active = not completed / cancelled / archived. */
  active: number;
  /** Reached the legal consent gate. */
  pastThreshold: number;
  /** Active collection sitting at zero signatures (the honest "stuck" proxy). */
  notStarted: number;
  /** Currently gathering signatures. */
  gathering: number;
}

export interface HomeTriage {
  pulse: OrgPulse;
  /** The FEW exception projects (near-threshold / not-started), most-urgent first. */
  exceptions: ProjectTriage[];
  /** Top projects worth a look, urgency-ranked (near/not-started → wins → rest). */
  needsAttention: ProjectTriage[];
  /** Total project count (M in "N מתוך M") — for the "all projects" link. */
  total: number;
}

export interface ComputeHomeTriageOptions {
  /** Cap on the exception list (north star: ~3-4). */
  maxExceptions?: number;
  /** Cap on the "needs a look" list (north star: ~4-5). */
  maxAttention?: number;
}

/**
 * Fold the whole project list into the home's triage view-model. Pure.
 *
 * `exceptions` and `needsAttention` are STABLE-sorted by urgency rank (the
 * input order — created-desc from the BE — breaks ties), so the result is
 * deterministic for the same input. Archived projects are excluded from the
 * pulse counts and the lists (they are out of the active mission).
 */
export function computeHomeTriage(
  projects: ProjectViewModel[],
  options: ComputeHomeTriageOptions = {},
): HomeTriage {
  const maxExceptions = options.maxExceptions ?? 4;
  const maxAttention = options.maxAttention ?? 5;

  const live = projects.filter((p) => !p.isArchived);
  const triaged = live.map(deriveProjectTriage);

  const pulse: OrgPulse = {
    active: triaged.filter((t) => t.kind !== 'completed' && t.kind !== 'cancelled').length,
    pastThreshold: triaged.filter((t) => t.kind === 'past_threshold').length,
    notStarted: triaged.filter((t) => t.kind === 'not_started').length,
    gathering: triaged.filter((t) => t.project.status === 'gathering_signatures').length,
  };

  const byUrgency = stableSortByRank(triaged);

  const exceptions = byUrgency.filter((t) => t.isException).slice(0, maxExceptions);
  const needsAttention = byUrgency.slice(0, maxAttention);

  return {
    pulse,
    exceptions,
    needsAttention,
    total: live.length,
  };
}

/** Stable sort by ascending rank — preserves input order for equal ranks. */
function stableSortByRank(items: ProjectTriage[]): ProjectTriage[] {
  return items
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.rank - b.t.rank || a.i - b.i)
    .map(({ t }) => t);
}
