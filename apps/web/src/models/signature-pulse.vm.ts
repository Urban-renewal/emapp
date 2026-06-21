import type { ConsentBasis } from '@emapp/shared-types';

/**
 * ViewModel for the board-first mission-control home (E2 Wave-2 E2.1).
 *
 * The wire `SignaturePulse` (B1) carries raw signals per project; this VM
 * pre-derives everything the presentational home needs so the components stay
 * dumb (Doc 05 §9.8 — adapters own derivation, components own layout):
 *
 *  - the ONE calm pulse sentence summarising the org from `buckets`,
 *  - up to N ranked ActionCards, each with its plain-Hebrew "why" + a stable
 *    `intent` for the status chip + the consent %/basis (never a bare %),
 *  - whether the whole feed is the calm "all under control" reward state.
 *
 * Ranking is NOT re-computed here — the wire `attention[]` is already ordered
 * most-urgent-first by the server's `rankAttention`. The adapter preserves that
 * order and only maps + truncates.
 */

/** The reason an ActionCard surfaced — drives its plain-Hebrew "why" line and
 *  the status-chip intent. Mutually exclusive, highest-urgency wins (mirrors the
 *  server's stalled > expiring > consent-gap precedence). */
export type PulseReason = 'stalled' | 'expiring' | 'consentGap' | 'notStarted';

/** One ranked project that needs the manager's attention. */
export interface PulseActionCardViewModel {
  projectId: string;
  /** Bidi-stripped project name (RTL-spoof safe; wrap in <NameDisplay>). */
  projectName: string;
  /** Why this card surfaced (already the top-priority reason for the row). */
  reason: PulseReason;
  /** Status-chip intent for the reason (danger=stalled, warning=expiring/gap,
   *  neutral=not-started). Reuses the shared badge intent vocabulary. */
  intent: 'danger' | 'warning' | 'neutral';
  /** Days since the last signature — present only for a `stalled` card. */
  stalledDays: number | null;
  /** Share-weighted consent %, 0–100. Always paired with `basis` in the UI. */
  consentedPct: number;
  /** Consent-computation basis — drives the MANDATORY label next to the %. */
  basis: ConsentBasis;
  /** Has the project met its signature threshold? (a met project never cards). */
  metThreshold: boolean;
  /** HB-5 (one-click holdout chase) — the project's CAMPAIGN document id (the doc
   *  a holdout signature-request is CREATED against when the owner has no live
   *  pending request). null when the project has no campaign at all. */
  campaignDocumentId: string | null;
  /** HB-5 — `campaignDocumentId !== null`. Drives the card's primary action:
   *  when false the board offers "start signature collection" (a link to the
   *  project) instead of a dead-end remind. */
  hasCampaign: boolean;
}

/**
 * NS-Fleet — the calm at-a-glance state of ONE project in the full-fleet grid.
 *
 * The fleet tile is NOT the project LIFECYCLE status (planning / gathering /
 * approved …) — the signature-pulse wire carries no status enum (it is a
 * SIGNATURE mission-control feed, not the project list). The tile's chip is the
 * project's SIGNATURE state, derived from the SAME signals the attention cards
 * use, plus two calm non-attention states the cards never show (a met project
 * and an on-track project never card, but they DO appear in the fleet):
 *   - 'stalled' / 'expiring' / 'consentGap' / 'notStarted' — the attention
 *     reasons (a project also surfaced as a card above is one of these);
 *   - 'met'     — consent has crossed the legal threshold (calm success);
 *   - 'onTrack' — has consent, short of target, but nothing flagged it for
 *     attention (calm neutral — "moving along").
 */
export type FleetState =
  | 'stalled'
  | 'expiring'
  | 'consentGap'
  | 'notStarted'
  | 'met'
  | 'onTrack';

/** One project in the full-fleet grid (ALL in-scope projects, calm tiles). */
export interface FleetProjectViewModel {
  projectId: string;
  /** Bidi-stripped project name (RTL-spoof safe; wrap in <NameDisplay>). */
  projectName: string;
  /** The project's signature state → drives the tile's status chip + intent. */
  state: FleetState;
  /** Status-chip intent for the state (reuses the shared badge vocabulary). */
  intent: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** Share-weighted consent %, 0–100 — the tile's thin sliver + % text. */
  consentedPct: number;
  /** Has the project met its signature threshold? (drives the sliver tone). */
  metThreshold: boolean;
  /** True when this project ALSO appears as a ranked attention card above — the
   *  tile may subtly mark it, but it is NEVER hidden (the REST stays visible). */
  isOnBoard: boolean;
}

/** The buckets summary, passed through verbatim for the pulse sentence. */
export interface PulseBucketsViewModel {
  stalled: number;
  expiringSoon: number;
  needsHuman: number;
  onTrack: number;
}

export interface SignaturePulseViewModel {
  buckets: PulseBucketsViewModel;
  /** Up to N ranked ActionCards (server order preserved). */
  cards: PulseActionCardViewModel[];
  /** NS-Fleet — the FULL in-scope project list as calm tiles (server order
   *  preserved: most-urgent first). Capped at `FLEET_TILE_CAP`; when the org
   *  has more, `fleetCapped` is true and the section offers a "show all" link
   *  to /projects rather than rendering hundreds of tiles. */
  fleet: FleetProjectViewModel[];
  /** True when the in-scope project count exceeds the tile cap → the fleet grid
   *  shows the first `FLEET_TILE_CAP` and a "הצג הכל" link to the projects list. */
  fleetCapped: boolean;
  /** True when nothing needs attention → the calm reward empty-state. */
  isAllClear: boolean;
  /** Total projects in scope (sum of the mutually-exclusive buckets) — used by
   *  the empty-state copy to distinguish "no projects yet" from "all on track". */
  totalInScope: number;
  /** HB-1 — is the global campaign-send KILL-SWITCH on? `true` = the one-tap
   *  "remind pending" / campaign actions are live; `false` = the switch is off
   *  (every send endpoint 503s) so the board should disable + explain the action
   *  rather than let the manager tap into a failure. Passed through verbatim from
   *  the wire `sendEnabled`. */
  sendEnabled: boolean;
}
