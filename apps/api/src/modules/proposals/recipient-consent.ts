/**
 * `resolveRecipientConsent` — THE ONE canonical answer to "may we deliver this
 * governed outbound to its recipient?" for EVERY autonomous governed-send executor
 * (reminders, reissues, document chases). It is the single source of truth the
 * `ConsentGate` (`@emapp/jobs/outbound-policy`) consumes via the resolved snapshot.
 *
 * ── WHY THIS EXISTS (the #516 consent-bypass class) ─────────────────────────────
 * The #516 bug was three executors on the SAME `governOutboundSend` engine
 * answering this question INCONSISTENTLY: the chase executor resolved it
 * fail-closed, while `sendGovernedReminder` and `reissueAndDeliver` HARDCODED
 * `recipientConsented: true` straight into `governOutboundSend` — making the
 * ConsentGate structurally unable to deny. With NO per-owner opt-out registry yet
 * (#512), that `true` was UNCONDITIONAL: every reminder + every reissue fired
 * regardless of consent, so an opted-out apartment owner was still emailed/SMS'd.
 *
 * The fix (CLAUDE.md "ONE source of truth + reuse the canonical flow, never
 * re-implement"): ALL THREE executors resolve consent through THIS one seam. No
 * executor hardcodes a consent boolean anymore.
 *
 * ── FAIL-CLOSED until the opt-out registry lands ────────────────────────────────
 * There is NO per-owner outbound opt-out registry table yet (#512 is unbuilt).
 * Until it exists we CANNOT affirmatively confirm any recipient's consent, so we
 * FAIL CLOSED — `recipientConsented: false`. The ConsentGate then DENIES → the
 * Governor returns `blocked` with NO ledger claim and NO send. This is the
 * consent-SAFE posture: governed reminders / reissues / chases do NOT deliver to
 * real recipients until consent can be read for real (which is itself the
 * owner-gated unblocker for real outbound). The re-mint / proposal mechanics are
 * unaffected — ONLY the governed DELIVERY is consent-gated.
 *
 * PII-FREE: this is a pure decision with NO I/O and NO contact details today. When
 * #512 lands, the SINGLE place this flips to a real lookup is the body below — read
 * the resolved recipient's opt-out state from the registry, here and ONLY here.
 */

/**
 * Resolve whether a governed-outbound recipient's consent can be AFFIRMATIVELY
 * confirmed for this send.
 *
 * Fail-closed: with no opt-out registry (#512) merged, consent CANNOT be confirmed
 * → `false`. Pure (no I/O today) so every executor + its tests pin the fail-closed
 * behavior without a DB round-trip. The `recipientRef` is the NON-PII send
 * discriminator the executor already keys the ledger on (never a contact detail);
 * it is the handle the future opt-out lookup will resolve the party/owner from.
 *
 * @returns `true` only when consent is affirmatively confirmed; `false` otherwise.
 */
export function resolveRecipientConsent(_recipientRef: string): boolean {
  // TODO (#512): read the per-recipient outbound opt-out registry for the recipient
  // resolved from `_recipientRef`. THIS is the ONLY place the value flips from the
  // fail-closed default to a real consent lookup. Until then we CANNOT confirm
  // consent → fail closed (never true) so no opted-out recipient is ever sent to.
  return false;
}
