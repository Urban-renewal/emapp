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
