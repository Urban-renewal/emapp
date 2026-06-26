/**
 * `executeDocumentChase` — the S5 `document.chase.send` proposal EXECUTOR
 * (DOCUMENTS-PROCESS-DESIGN.md S5).
 *
 * On the manager's one-click APPROVE of a `document.chase.send` proposal, this
 * routes the chase send through the CANONICAL `governOutboundSend` seam — the SAME
 * exactly-once + gate pipeline `sendGovernedReminder` uses. It does NOT re-implement
 * an outbound path (that re-implementation is exactly the #516 consent-bypass class
 * of bug the charter forbids).
 *
 * ── CRITICAL SECURITY CONSTRAINT — consent is resolved, NEVER hardcoded ──────
 * The #516 consent-bypass was `reissueAndDeliver` passing `recipientConsented:true`
 * to `governOutboundSend`, so an OPTED-OUT party still got the message. We do NOT
 * repeat it. Consent is resolved through the ONE canonical seam shared by ALL
 * governed-send executors — `resolveRecipientConsent` (`./recipient-consent`) — the
 * same seam the reminder + reissue executors now use (no executor hardcodes a
 * consent boolean). Two registries this chase ALSO depends on are NOT yet merged:
 *   1. the recipient opt-out registry (#512) — the source of a party's REAL
 *      consent state (the shared seam's fail-closed default flips to a real read
 *      here when it lands); and
 *   2. a party-recipient RESOLVER — "the שמאי's email" for a project's appraiser
 *      party (the X-S6 collaboration / external_share recipient-identity work).
 * Until the opt-out registry lands, the shared seam CANNOT affirmatively confirm
 * consent. So we FAIL CLOSED:
 *   - `recipientConsented: false` → the pure ConsentGate DENIES the send →
 *     `governOutboundSend` returns `blocked` with NO ledger claim and NO send. The
 *     proposal stays PENDING (actionable) — nothing leaves the system.
 *   - The `send` thunk is ALSO fail-closed (returns a DEFINITE non-delivery
 *     `no_party_recipient`): defense-in-depth so that even if a future change makes
 *     the gate allow before a real recipient resolver exists, no empty/blind send
 *     can dispatch.
 * This is the propose-path-safe / send-path-consent-gated posture S5 mandates: the
 * recommender + proposal + inbox surface are fully built and safe; only the actual
 * dispatch is gated behind the two pending registries.
 *
 * TODO (S6 / #512): when the opt-out registry + the party-recipient resolver land,
 * the shared `resolveRecipientConsent` becomes a real read of the opt-out table,
 * and this executor wires the `send` thunk to mint an `external_share` upload link +
 * deliver it via the existing share-delivery path — STILL through this
 * `governOutboundSend` call (the seam does not change; only the resolved consent +
 * the send thunk's body do).
 *
 * NO PII: the evidence is the PII-free snapshot (project + type + party + track);
 * the recipientRef is a NON-PII discriminator (the proposal scope id : type), never
 * a contact detail.
 */
import { serverEnv } from '@emapp/config';
import { governOutboundSend, type GovernedSendOutcome, type Proposal } from '@emapp/db';
import { providerPartyForDocType, type DocumentParty } from '@emapp/shared-types';
import { z } from 'zod';

import { resolveRecipientConsent } from './recipient-consent';

/** The PII-free `document.chase.send` evidence shape we depend on at execute time.
 *  Zod-parsed (no raw `unknown` access, per CLAUDE.md) — a malformed evidence blob
 *  fails closed rather than chasing the wrong party. The responsible PARTY is
 *  DERIVED from `missingDocType` via the canonical `providerPartyForDocType` (the
 *  recommender, in `@emapp/db`, cannot import shared-types — the package cycle rule
 *  — so the type is the single-sourced fact and the party is computed HERE). */
export const DocumentChaseEvidence = z.object({
  condition: z.literal('missing_required_doc'),
  projectId: z.string().uuid(),
  missingDocType: z.string().min(1).max(50),
});
export type DocumentChaseEvidenceDto = z.infer<typeof DocumentChaseEvidence>;

/** The responsible chase party for this gap, derived from the missing TYPE via the
 *  ONE canonical mapping. Pure + deterministic; exposed for the FE copy / future
 *  party-recipient resolution. */
export function chasePartyForEvidence(evidence: DocumentChaseEvidenceDto): DocumentParty {
  return providerPartyForDocType(evidence.missingDocType);
}

/**
 * Execute a `document.chase.send` proposal: route the chase through the canonical
 * governed-outbound seam with the REAL (fail-closed) consent state. Returns the
 * governed outcome so the caller (ProposalsService) can map a non-`sent` outcome
 * to the SAME exception/keep-pending semantics as the reminder executor.
 */
export async function executeDocumentChase(
  orgId: string,
  proposal: Proposal,
): Promise<GovernedSendOutcome> {
  const evidence = DocumentChaseEvidence.parse(proposal.evidence);

  // Resolve the kill-switch the SAME way the reminder path does (OPT-OUT: enabled
  // unless explicitly disabled). The gate is the single authoritative check.
  const sendFlag = serverEnv.CAMPAIGN_SEND_ENABLED;
  const killSwitchEnabled = sendFlag !== '0' && sendFlag !== 'false';

  // NON-PII recipient discriminator: the chase target is "this project's missing
  // <type>" — keyed on (projectId:type) so a re-proposal of the SAME gap collides
  // on the M1 ledger key (no double-send), exactly like the reminder path keys on
  // (signatureRequestId:step). NOT a contact detail.
  const recipientRef = `${evidence.projectId}:${evidence.missingDocType}`;

  // Resolve consent through the ONE canonical seam (never hardcoded true — the #516
  // lesson). Fail-closed until the opt-out registry (#512) lands → `false` → the
  // ConsentGate denies → `blocked`, nothing is sent, the proposal stays pending.
  const recipientConsented = resolveRecipientConsent(recipientRef);

  return governOutboundSend({
    orgId,
    proposalId: proposal.id,
    // The chase is delivered as a party share/request (X-S6) → the share rate
    // bucket, matching the AutonomyPolicy classification's rateBucket.
    channel: 'email',
    recipientRef,
    // cadenceStep 0 — a chase is one-shot per gap (a re-opened gap re-proposes with
    // the SAME (project,type) key, so the ledger dedups it).
    cadenceStep: 0,
    recipientConsented,
    killSwitchEnabled,
    breakerTripped: false,
    now: new Date(),
    // FAIL-CLOSED send thunk (defense-in-depth): there is no party-recipient
    // resolver yet, so even if the gate ever allowed, there is NO real recipient to
    // dispatch to. Return a DEFINITE non-delivery so the Governor settles `failed`
    // (re-claimable later) rather than an ambiguous park — the message provably did
    // NOT go out. Wired to a real share-link delivery when X-S6 lands.
    send: async () => ({
      delivered: false,
      failureKind: 'definite' as const,
      failureCode: 'no_party_recipient',
    }),
  });
}
