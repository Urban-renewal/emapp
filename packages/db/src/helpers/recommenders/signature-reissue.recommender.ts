/**
 * `SignatureReissueRecommender` — the FIRST autonomy producer (Autonomous Master
 * Plan, Phase 1; "the safest first producer": expiry → re-issue).
 *
 * THE LOOP: the hourly `sweep:signature-expiry` job flips lapsed `pending`
 * signature_requests to `expired`. This recommender then DETECTS recently-expired,
 * still-unsigned requests and PROPOSES re-issuing them (re-mint a fresh signing
 * link). The proposal is INTERNAL + reversible + non-PII (no email/SMS leaves the
 * system here — that is Phase 2's outbound cadence); the manager confirms with one
 * click and the executor replays the gated re-mint.
 *
 * ── Set-based detection (design correction H-runtime) ───────────────────────
 * ONE query across ALL orgs via the BYPASSRLS maintenance pool (`providerDb`),
 * exactly like `sweepExpiredSignatureRequests` — NOT a per-org loop. The producer
 * then writes per-tenant (the only necessarily-scoped step). The query reads ONLY
 * non-PII columns (id, org_id, expires_at) — never owner_id-joined PII.
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'signature_request.reissue:<requestId>'` — DETERMINISTIC per
 * request (no timestamp/nonce). The partial-unique on
 * `proposals(org_id, dedup_key) WHERE pending` makes a second detection of the
 * same expired request a no-op while a proposal is still live; once the manager
 * approves/rejects it, the key releases so a request that lapses AGAIN later can
 * be re-proposed.
 *
 * ── Detection window ────────────────────────────────────────────────────────
 * Only requests that expired within `lookbackDays` (default 30) are proposed —
 * a request that expired months ago and was never re-issued is stale signal, not
 * a fresh chase. Bounds the working set + keeps the inbox calm. `now` is injected
 * (RecommenderContext) so the window is deterministic in tests.
 *
 * NO PII: the evidence snapshot carries only the request id + expiry timestamp +
 * org id — never owner national_id/phone/name (the PII-free-proposal contract).
 */
import type { DetectedCondition, IRecommender, RecommenderContext } from '@emapp/jobs';
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** The kind the produced proposals carry (classified internal+reversible+non-PII). */
export const SIGNATURE_REISSUE_KIND = 'signature_request.reissue' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const SIGNATURE_REISSUE_RECOMMENDER_ID = 'signature-reissue' as const;

/** Default lookback: only requests expired within the last 30 days are proposed. */
export const SIGNATURE_REISSUE_LOOKBACK_DAYS = 30;

/** Default proposal TTL: a reissue proposal the manager never touches retires
 *  after 14 days (the inbox stays calm; the request can still be hand-resent). */
export const SIGNATURE_REISSUE_PROPOSAL_TTL_DAYS = 14;

export interface SignatureReissueRecommenderOptions {
  lookbackDays?: number;
  proposalTtlDays?: number;
}

/**
 * Build the reissue recommender. Pure detection — it reads expired requests and
 * returns conditions; the generic ProposalProducer does the per-tenant emit.
 */
export function createSignatureReissueRecommender(
  opts: SignatureReissueRecommenderOptions = {},
): IRecommender {
  const lookbackDays = opts.lookbackDays ?? SIGNATURE_REISSUE_LOOKBACK_DAYS;
  const proposalTtlDays = opts.proposalTtlDays ?? SIGNATURE_REISSUE_PROPOSAL_TTL_DAYS;

  return {
    id: SIGNATURE_REISSUE_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const windowStart = new Date(ctx.now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
      const expiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);

      // ONE set-based query across all orgs. Reads only non-PII columns. A
      // request is a reissue candidate iff it is `expired` (the sweep flipped
      // it), never signed/cancelled, and lapsed within the lookback window.
      const result = await providerDb.execute(sql`
        SELECT id, org_id, expires_at
          FROM signature_requests
         WHERE status = 'expired'
           AND expires_at >= ${windowStart}
           AND expires_at <= ${ctx.now}
         ORDER BY expires_at DESC
         LIMIT 5000
      `);

      const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

      return rows.map((row): DetectedCondition => {
        const requestId = String(row['id']);
        const orgId = String(row['org_id']);
        const expired = row['expires_at'];
        const expiredIso = expired instanceof Date ? expired.toISOString() : String(expired);
        return {
          orgId,
          kind: SIGNATURE_REISSUE_KIND,
          scopeType: 'signature_request',
          scopeId: requestId,
          // PII-FREE evidence snapshot: ids + timestamp only.
          evidence: {
            signatureRequestId: requestId,
            expiredAt: expiredIso,
            reason: 'expired_unsigned',
          },
          // DETERMINISTIC dedup key per request — no timestamp/nonce.
          dedupKey: `${SIGNATURE_REISSUE_KIND}:${requestId}`,
          expiresAt,
        };
      });
    },
  };
}
