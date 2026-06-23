/**
 * Proposal ViewModel — Autonomous Master Plan, Phase 1 (the Approval Inbox).
 *
 * The wire `ProposalView` (shared-types/proposal.ts) carries neutral DATA: a
 * `kind`, a PII-free `evidence` snapshot (ids/counts/timestamps only), a scope,
 * and timestamps. The VM composes the CALM, user-framed copy from it.
 *
 * VOICE LAW (owner-mandated — see feedback_user_keeps_control_not_system_voice):
 * every string frames the work as the USER's pending decision, NEVER the
 * system's heroics. So `whyTitle` reads "בקשת חתימה שפגה — מוצע להנפיק מחדש"
 * (neutral-passive "מוצע", the DECISION is the user's), never "הנפקתי מחדש".
 * The CTAs (in the card) are the user's verb ([אשר]/[דחה]).
 *
 * NO PII ever flows into the VM — the adapter reads only the kind + ids/counts
 * from `evidence`; it never reads (and the wire never carries) a name /
 * national_id / phone. The adapter's spec asserts this.
 */

export interface ProposalViewModel {
  id: string;
  /** The action kind the proposal carries (e.g. `signature_request.reissue`). */
  kind: string;
  /** The user-framed "why" — a neutral-passive one-liner. NEVER system-voice. */
  whyTitle: string;
  /** A short, calm sub-line of supporting context (PII-free; ids/counts only). */
  scopeLabel: string;
  /** The verb the APPROVE button performs, in the user's voice (e.g. "אשר"). */
  approveLabel: string;
  /** When the proposal was prepared, relative ("לפני שעה"). */
  createdRelative: string;
  createdAtIso: string;
}

/**
 * The CONFIRMATION an APPROVE surfaces — derived from the wire `delivery`
 * outcome (shared-types `ProposalApplyDelivery`) so the manager grasps, at a
 * glance, the REAL-WORLD result of the click: was the owner re-contacted, and
 * on which channel — or was nothing sent (and why).
 *
 * This is the LEGIBILITY contract (G-QA rule #3): a state-change must visibly
 * confirm its real-world outcome. A `state: 'sent'` shows a CALM success that
 * names the channel + masked recipient ("הבעלים קיבל קישור חדש ב<דוא״ל>");
 * every NON-`sent` state shows an HONEST non-success — never a false "sent".
 *
 * VOICE LAW: the copy (composed at the client via next-intl from this neutral
 * model) frames the owner as the actor of the outcome ("הבעלים קיבל…"), never
 * the system as a first-person hero.
 *
 * `messageKey` is an i18n key under `inbox.delivery.*` (the client interpolates
 * the channel + recipient). `tone` routes the toast region: `success` /
 * `neutral` → polite; `warning` → assertive (the manager must NOT mistake a
 * non-send for a send).
 */
export interface ProposalApproveOutcome {
  /** The governed-outbound state bucket, carried verbatim for the i18n key. */
  state: 'sent' | 'already_sent' | 'blocked' | 'failed' | 'ambiguous' | 'no_channel';
  /** i18n key under `inbox.delivery` — the client resolves + interpolates it. */
  messageKey: string;
  /** Toast urgency: a non-send is `warning` (assertive) so it can't read as a send. */
  tone: 'success' | 'neutral' | 'warning';
  /** The channel that carried it, for interpolation (translated at the client). */
  channel: 'email' | 'sms' | 'whatsapp' | null;
  /** MASKED recipient (`na***@domain`) for interpolation; `null` when absent. */
  recipient: string | null;
}
