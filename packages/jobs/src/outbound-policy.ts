/**
 * `OutboundPolicy` — the GATE PIPELINE (Autonomous Master Plan, Phase 2; design
 * correction H-solid: "OutboundGovernor is a gate pipeline, not a god-object").
 *
 * The decision of whether a governed outbound send may proceed is decomposed
 * into a list of small, composable, CLOCK-INJECTED gates:
 *
 *   KillSwitchGate · ConsentGate · QuietHoursGate · RateCeilingGate · CircuitBreaker
 *
 * Each gate is a PURE function of `(request, ctx) -> GateVerdict` — no DB, no I/O,
 * no wall-clock read (the clock is in `ctx.now`). That makes every gate an
 * independently-unit-testable decision table, mirroring `AutonomyPolicy.classify`
 * being a pure table. The DB-backed inputs (the kill-switch flag, the recipient's
 * consent/opt-out, the recent-send counts) are RESOLVED by the Governor (in
 * `@emapp/db`, which has DB access) and handed in as a snapshot — the gates never
 * reach out themselves. This keeps the policy FE-safe + dependency-light (imports
 * only this module's types) and the Governor thin (it orchestrates + does the
 * ledger claim, it does not embed the rules).
 *
 * `evaluate(request, ctx)` runs the gates IN ORDER and short-circuits on the
 * first non-allow verdict:
 *   - `deny`  — a hard stop (kill-switch off, consent withdrawn, breaker tripped,
 *               rate ceiling hit). The send must NOT go out now; the proposal
 *               stays actionable so a human can retry later if the condition lifts.
 *   - `defer` — not now, but legitimately later (quiet hours). The send is held;
 *               the caller surfaces "held — will resume after quiet hours" rather
 *               than a failure. (In Phase 2 the executor treats `defer` as a
 *               clean 409-class "not now" — no send, proposal stays pending.)
 *   - `allow` — every gate passed; the Governor proceeds to the ledger claim + send.
 *
 * This file lives in `@emapp/jobs` and imports ONLY its own types (no zod, no
 * node:, no DB), so it is FE-safe and pure. The CONCRETE Governor that resolves
 * the snapshot + claims the ledger + calls the providers lives in `@emapp/db`.
 */

/** The three terminal gate verdicts. `defer` is distinct from `deny`: a deferred
 *  send is legitimately retriable soon (quiet hours), a denied one is blocked
 *  (kill-switch / consent / breaker / ceiling) until its condition changes. */
export type OutboundVerdict = 'allow' | 'deny' | 'defer';

/** A gate's structured result: the verdict + a NON-PII machine code naming the
 *  gate + reason, for audit/observability. `gate` identifies which gate fired;
 *  `reason` is a stable code (never PII, never a provider error string). */
export interface GateVerdict {
  verdict: OutboundVerdict;
  /** Stable id of the gate that produced this verdict (for logs/audit). */
  gate: string;
  /** Stable NON-PII reason code (e.g. 'kill_switch_off', 'quiet_hours'). */
  reason: string;
}

/** The describe-the-send request a gate evaluates. All NON-PII: the recipient is
 *  a stable id (the signature_request), never the email/phone. */
export interface OutboundRequest {
  orgId: string;
  /** The channel this send would use. */
  channel: 'email' | 'sms';
  /** NON-PII recipient discriminator (the signature_request id). */
  recipientRef: string;
  /** The cadence step (0/+3/+7/+14 → 0..3). */
  cadenceStep: number;
}

/** The snapshot of DB-resolved facts the Governor hands the gates. Resolving
 *  these is the Governor's job (it has DB access); the gates only DECIDE. */
export interface OutboundSnapshot {
  /** The CAMPAIGN_SEND_ENABLED kill-switch state (resolved from env). */
  killSwitchEnabled: boolean;
  /** Whether the recipient is consented (NOT opted-out) for outbound on this
   *  channel. Resolved by the Governor; absent opt-out registry → true (the
   *  documented seam for a future per-owner opt-out table). */
  recipientConsented: boolean;
  /** Count of sends to THIS recipient within the per-recipient window. */
  recipientSendsInWindow: number;
  /** Count of sends across the ORG within the per-org window. */
  orgSendsInWindow: number;
  /** Whether the per-org outbound circuit breaker is currently tripped (PAUSE). */
  breakerTripped: boolean;
}

/** Per-gate ceilings + clock. Clock is injected so QuietHours + windows are
 *  deterministic in tests. */
export interface OutboundPolicyConfig {
  /** Max sends to one recipient within the recipient window (RateCeilingGate). */
  maxPerRecipient: number;
  /** Max sends across the org within the org window (RateCeilingGate). */
  maxPerOrg: number;
  /** Quiet-hours window in Asia/Jerusalem local time, [startHour, endHour).
   *  Sends in [start, end) are DEFERRED. Default 21:00–08:00 (no night sends). */
  quietHoursStartHour: number;
  quietHoursEndHour: number;
}

export const DEFAULT_OUTBOUND_POLICY_CONFIG: OutboundPolicyConfig = {
  maxPerRecipient: 1, // one reminder per recipient per window (no-nag, charter §5)
  maxPerOrg: 500, // org-wide send-bomb ceiling (charter risk #3)
  quietHoursStartHour: 21, // 21:00 Asia/Jerusalem
  quietHoursEndHour: 8, // 08:00 Asia/Jerusalem
};

/** The context every gate receives: the resolved snapshot, the config, and the
 *  injected clock. */
export interface GateContext {
  now: Date;
  snapshot: OutboundSnapshot;
  config: OutboundPolicyConfig;
}

/** A gate is a PURE decision over (request, ctx). No I/O, no wall-clock. */
export type OutboundGate = (request: OutboundRequest, ctx: GateContext) => GateVerdict;

const allow = (gate: string): GateVerdict => ({ verdict: 'allow', gate, reason: 'ok' });

// ─────────────────────────────────────────────────────────────────────────────
// The gates. Each is pure + independently testable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KillSwitchGate — the global CAMPAIGN_SEND_ENABLED kill-switch. When the switch
 * is OFF, NOTHING outbound goes out (charter §6: global kill-switch pre-disables
 * outbound). DENY (not defer) — the manager flipped it off deliberately.
 */
export const KillSwitchGate: OutboundGate = (_req, ctx) =>
  ctx.snapshot.killSwitchEnabled
    ? allow('kill_switch')
    : { verdict: 'deny', gate: 'kill_switch', reason: 'kill_switch_off' };

/**
 * ConsentGate — per-recipient consent / opt-out (charter §4). A recipient who
 * has withdrawn consent for outbound is never sent to. DENY.
 */
export const ConsentGate: OutboundGate = (_req, ctx) =>
  ctx.snapshot.recipientConsented
    ? allow('consent')
    : { verdict: 'deny', gate: 'consent', reason: 'consent_withdrawn' };

/**
 * Is `hour` (0..23) inside the quiet window [startHour, endHour)? Handles the
 * common WRAP case (e.g. 21..8 means 21,22,23,0,..,7). Pure — exported for tests.
 */
export function isWithinQuietHours(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false; // empty window
  if (startHour < endHour) {
    // Same-day window, e.g. 1..5.
    return hour >= startHour && hour < endHour;
  }
  // Wrapping window, e.g. 21..8 → [21..24) ∪ [0..8).
  return hour >= startHour || hour < endHour;
}

/** The Asia/Jerusalem local hour (0..23) for an instant. Uses Intl (no extra dep)
 *  so DST is handled correctly. Pure given `now`. Exported for tests. */
export function jerusalemHour(now: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: 'numeric',
    hour12: false,
  });
  // Intl can render midnight as '24'; normalize to 0.
  const raw = Number.parseInt(fmt.format(now), 10);
  return raw === 24 ? 0 : raw;
}

/**
 * QuietHoursGate — defer sends during Asia/Jerusalem quiet hours (charter §4).
 * DEFER (not deny): the send is legitimate, just not at this hour. The Governor
 * holds it; the next attempt outside the window proceeds. (OTP/transactional
 * would be quiet-hours-EXEMPT per the charter, but the reminder cadence is NOT
 * transactional, so it respects quiet hours.)
 */
export const QuietHoursGate: OutboundGate = (_req, ctx) => {
  const hour = jerusalemHour(ctx.now);
  return isWithinQuietHours(hour, ctx.config.quietHoursStartHour, ctx.config.quietHoursEndHour)
    ? { verdict: 'defer', gate: 'quiet_hours', reason: 'quiet_hours' }
    : allow('quiet_hours');
};

/**
 * RateCeilingGate — per-recipient + per-org ceilings (charter §5: rate-limit +
 * no-nag). DENY when either ceiling is reached (the send would exceed the cap).
 */
export const RateCeilingGate: OutboundGate = (_req, ctx) => {
  if (ctx.snapshot.recipientSendsInWindow >= ctx.config.maxPerRecipient) {
    return { verdict: 'deny', gate: 'rate_ceiling', reason: 'recipient_ceiling' };
  }
  if (ctx.snapshot.orgSendsInWindow >= ctx.config.maxPerOrg) {
    return { verdict: 'deny', gate: 'rate_ceiling', reason: 'org_ceiling' };
  }
  return allow('rate_ceiling');
};

/**
 * CircuitBreaker — fail-safe PAUSE-only breaker (charter §6). When tripped, all
 * outbound DENIES until a human RESUMES. The breaker only ever PAUSES; it never
 * auto-resumes a send. DENY.
 */
export const CircuitBreaker: OutboundGate = (_req, ctx) =>
  ctx.snapshot.breakerTripped
    ? { verdict: 'deny', gate: 'circuit_breaker', reason: 'breaker_tripped' }
    : allow('circuit_breaker');

/**
 * The default gate pipeline, in evaluation order. Kill-switch + breaker (cheap
 * hard stops) first, then consent, then quiet-hours (defer), then the ceilings.
 * The order is deliberate: a denied send should report the most fundamental
 * reason (the switch is off) over a softer one (quiet hours).
 */
export const DEFAULT_OUTBOUND_GATES: readonly OutboundGate[] = [
  KillSwitchGate,
  ConsentGate,
  CircuitBreaker,
  QuietHoursGate,
  RateCeilingGate,
];

/** The result of evaluating the full pipeline: the terminal verdict + which gate
 *  produced it (allow ⇒ the last gate). */
export interface OutboundPolicyDecision {
  verdict: OutboundVerdict;
  gate: string;
  reason: string;
}

/**
 * `OutboundPolicy.evaluate` — run the gate list in order, short-circuiting on the
 * first non-`allow` verdict. An empty gate list (or all-allow) yields `allow`.
 * PURE: identical inputs → identical decision. The Governor calls this, then —
 * only on `allow` — does the ledger claim + the provider send.
 */
export function evaluateOutboundPolicy(
  request: OutboundRequest,
  ctx: GateContext,
  gates: readonly OutboundGate[] = DEFAULT_OUTBOUND_GATES,
): OutboundPolicyDecision {
  for (const gate of gates) {
    const v = gate(request, ctx);
    if (v.verdict !== 'allow') {
      return { verdict: v.verdict, gate: v.gate, reason: v.reason };
    }
  }
  return { verdict: 'allow', gate: 'pipeline', reason: 'ok' };
}
