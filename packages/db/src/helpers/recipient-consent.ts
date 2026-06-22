/**
 * `resolveRecipientChannelSuppression` — the DB-backed resolver that feeds the
 * OutboundGovernor's `ConsentGate` + the per-channel delivery suppression (M2;
 * #506 reminder-cadence red-team MEDIUM finding + the round-2 SMS-leg HIGH).
 *
 * The ConsentGate is a PURE gate: it decides allow/deny from a boolean snapshot
 * (`recipientConsented`). Resolving that boolean is the GOVERNOR's job (it has DB
 * access). Until M2 the caller hard-coded `true` (a documented seam) — a
 * recipient who asked to stop could still be sent an autonomous reminder. This
 * helper closes that seam: it reads the `recipient_opt_outs` registry and
 * returns the real per-channel state.
 *
 * ── RESOLUTION ───────────────────────────────────────────────────────────────
 * The outbound path identifies the recipient by a signature_request id
 * (`recipientRef`), but an opt-out is a property of the PERSON (the owner): a
 * resident who opts out must stop receiving reminders for EVERY pending request.
 * So we resolve: signature_request → owner_id → recipient_opt_outs.
 *
 * ── PER-CHANNEL (the reminder fans out to BOTH email AND sms) ─────────────────
 * The autonomous reminder delivers on BOTH email and sms, so a per-channel
 * opt-out for EITHER must be honored — not just one nominal channel (the gap the
 * round-2 red-team found: an sms-only opt-out was still SMS'd). We return the
 * suppressed set per channel + the ConsentGate boolean, which DENIES only when
 * EVERY channel (or `all`) is suppressed (nothing left to send).
 *
 * ── FAIL-CLOSED (the consent axis is compliance-critical) ────────────────────
 * This helper THROWS on any lookup error (a missing request, a DB error). It
 * does NOT swallow + default-true. The CALLER (`sendGovernedReminder`) catches
 * the throw and treats an unresolved consent as a DENY — an opted-out recipient
 * must NEVER be sent to, and "we couldn't check" is, for consent, the same as
 * "don't send". This is the SAFE side: the worst case of a false-deny is a
 * reminder a manager can re-trigger by hand; the worst case of a false-allow is
 * an outbound to someone who legally opted out.
 *
 * ── NO PII ───────────────────────────────────────────────────────────────────
 * Resolution is by ids only (signature_request id → owner id). No email/phone is
 * read or logged.
 *
 * ── CHEAP (no N+1) ───────────────────────────────────────────────────────────
 * Two indexed point lookups in ONE round-trip inside the caller's open tenant
 * tx: the owner-id resolution (signature_requests PK) + the opt-out scan (the
 * recipient_opt_outs (org, owner, channel) index). No per-row fan-out.
 *
 * Runs inside the caller's `withTenant(orgId, …)` — the `tx` is RLS-scoped, so
 * cross-org rows are invisible by construction.
 */
import { and, eq } from 'drizzle-orm';

import { signatureRequests } from '../schema/artifacts';
import { recipientOptOuts } from '../schema/recipient-opt-outs';
import type { TenantTx } from '../wrappers/with-tenant';

/** Per-channel opt-out SUPPRESSION for one recipient: which concrete channels
 *  the recipient has opted out of. `all` suppresses BOTH. `consented` is the
 *  ConsentGate input: `false` ONLY when EVERY channel the send could use is
 *  suppressed (a fully-opted-out recipient); if only one channel is suppressed
 *  the gate still ALLOWs and the suppressed channel is skipped at delivery. */
export interface RecipientChannelSuppression {
  email: boolean;
  sms: boolean;
  /** ConsentGate input: false ⇒ DENY (every send channel is suppressed). */
  consented: boolean;
}

/**
 * Resolve the FULL per-channel opt-out picture for the recipient of
 * `signatureRequestId`, in ONE round-trip (the owner resolution + a single
 * opt-out scan). The autonomous reminder fans out to BOTH email and SMS, so a
 * per-channel opt-out for EITHER must be honored — this is what closes the
 * "sms-only opt-out still got SMS'd" gap.
 *
 * FAIL-CLOSED: THROWS on an unresolvable request / lookup error (the caller
 * treats a throw as a full DENY). Never returns a default-allow on error.
 *
 * The `consented` field is the ConsentGate boolean: DENY (false) only when the
 * recipient is opted out of BOTH channels (or `all`) — there is then nothing
 * left to send. A single-channel opt-out keeps `consented:true` (the gate
 * allows) and surfaces the suppressed channel so delivery skips it.
 */
export async function resolveRecipientChannelSuppression(
  tx: TenantTx,
  orgId: string,
  signatureRequestId: string,
): Promise<RecipientChannelSuppression> {
  const [req] = await tx
    .select({ ownerId: signatureRequests.ownerId })
    .from(signatureRequests)
    .where(and(eq(signatureRequests.id, signatureRequestId), eq(signatureRequests.orgId, orgId)))
    .limit(1);
  if (!req) {
    throw new Error('recipient_consent_unresolved: signature_request not visible');
  }

  const rows = await tx
    .select({ channel: recipientOptOuts.channel })
    .from(recipientOptOuts)
    .where(and(eq(recipientOptOuts.orgId, orgId), eq(recipientOptOuts.ownerId, req.ownerId)));

  const channels = new Set(rows.map((r) => r.channel));
  const all = channels.has('all');
  const email = all || channels.has('email');
  const sms = all || channels.has('sms');
  // DENY only when EVERY send channel is suppressed (nothing left to send).
  return { email, sms, consented: !(email && sms) };
}
