/**
 * `ReminderCadenceRecommender` — the Phase-2 GOVERNED-OUTBOUND recommender
 * (Autonomous Master Plan, Phase 2; top autonomy win #1 "reminder cadence by
 * rule, day 0/+3/+7/+14"). The first producer whose APPROVE drives a real
 * outbound send (through the OutboundGovernor) rather than an internal flip.
 *
 * THE LOOP: a pending, still-LIVE (not expired/signed/cancelled) signature
 * request that has had no response since its last contact, per the cadence
 * (+3/+7/+14 days, max 3 reminders), is DETECTED and PROPOSED as a
 * `reminder.send`. The manager confirms one-click; the executor sends ONE
 * reminder through the governed, exactly-once path.
 *
 * ── Set-based detection (design correction H-runtime) ───────────────────────
 * ONE query across ALL orgs via the BYPASSRLS maintenance pool (`providerDb`),
 * exactly like the reissue recommender + `sweepExpiredSignatureRequests` — NOT a
 * per-org loop. The query LEFT-JOINs the `outbound_ledger` to compute, per
 * request: how many reminders already went out (`reminders_sent` = terminal
 * `sent` rows whose recipient_ref is this request) and the last-contact time
 * (`last_contact_at` = max(created_at, last sent reminder)). The cadence clock
 * therefore lives in the ledger — no schema change to signature_requests.
 *
 * The pure `decideReminderCadence` policy then decides, per request, whether it
 * is DUE and at which cadence STEP. The producer writes per-tenant (the only
 * necessarily-scoped step).
 *
 * ── Idempotency (the dedup-key contract) ────────────────────────────────────
 * `dedupKey = 'reminder.send:<requestId>:<cadenceStep>'` — DETERMINISTIC per
 * (request, step). The partial-unique on `proposals(org_id, dedup_key) WHERE
 * pending` makes a second detection of the SAME step a no-op while the proposal
 * is live; a LATER cadence step (a different key) can legitimately re-propose.
 * This composes with the M1 ledger key (recipient + cadence_step — proposal_id is
 * DELIBERATELY NOT in the ledger key, so the send is deduped per recipient+step
 * STABLY across re-proposals; a parked send blocks a re-proposed duplicate): the
 * proposal is deduped at draft time, the SEND is deduped at execute time.
 *
 * ── Failed-send retry (#506 H1) — the cadence is consistent with re-claim ────
 * `reminders_sent` counts ONLY `sent` rows, so a DEFINITE-failed step-N ledger
 * row does NOT advance the count — the policy correctly re-derives step N, the
 * SAME idempotency key, and a re-approve RE-CLAIMS the failed ledger row (the
 * Governor's status-guarded UPDATE) → exactly one re-send, no double-send, no
 * mis-advance. `last_contact_at` likewise filters on `sent`, so a failed attempt
 * does not reset the cadence clock (the retry stays due). A PARKED ambiguous row
 * stays `pending_send` (also not counted as `sent`): the Governor's
 * pending_send→already_sent guard makes it un-resendable by this autonomous path,
 * so the re-proposed step-N is a no-op replay until a human disambiguates it.
 *
 * ── NO PII ──────────────────────────────────────────────────────────────────
 * The query reads ONLY non-PII columns (ids, timestamps, status, counts) — never
 * owner_id-joined national_id/phone/name. The evidence snapshot carries only the
 * request id + cadence step + days + the reminder index. The owner's address is
 * resolved at SEND time inside the gated method, never in the proposal.
 */
import {
  decideReminderCadence,
  REMINDER_CADENCE_DAYS,
  type DetectedCondition,
  type IRecommender,
  type RecommenderContext,
} from '@emapp/jobs';
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** The kind the produced proposals carry (classified outbound + consent → proposeConfirm). */
export const REMINDER_SEND_KIND = 'reminder.send' as const;

/** Stable recommender id for logs / per-producer isolation. */
export const REMINDER_CADENCE_RECOMMENDER_ID = 'reminder-cadence' as const;

/** Default proposal TTL: a reminder proposal the manager never touches retires
 *  after 7 days (shorter than reissue — a stale reminder loses relevance fast). */
export const REMINDER_PROPOSAL_TTL_DAYS = 7;

export interface ReminderCadenceRecommenderOptions {
  proposalTtlDays?: number;
}

/**
 * Build the reminder-cadence recommender. Pure detection — it reads due requests
 * (set-based, joined to the ledger for cadence state) and returns conditions; the
 * generic ProposalProducer does the per-tenant emit.
 */
export function createReminderCadenceRecommender(
  opts: ReminderCadenceRecommenderOptions = {},
): IRecommender {
  const proposalTtlDays = opts.proposalTtlDays ?? REMINDER_PROPOSAL_TTL_DAYS;

  return {
    id: REMINDER_CADENCE_RECOMMENDER_ID,
    async detect(ctx: RecommenderContext): Promise<DetectedCondition[]> {
      const proposalExpiresAt = new Date(ctx.now.getTime() + proposalTtlDays * 24 * 60 * 60 * 1000);
      // The oldest last-contact that could possibly be due is the LARGEST cadence
      // offset ago — anything more recent than (now - minCadence) can't be due
      // yet. Bounds the working set. min cadence = first offset (+3d).
      const minCadenceDays = REMINDER_CADENCE_DAYS[0];

      // ONE set-based query across all orgs. Reads only non-PII columns. A
      // request is a reminder candidate iff it is `pending`, still live
      // (expires_at > now), and its last contact is at least the minimum cadence
      // ago. The LEFT JOIN aggregates the ledger to derive reminders_sent +
      // last_contact_at; the pure policy decides the exact step below.
      const result = await providerDb.execute(sql`
        SELECT
          sr.id          AS id,
          sr.org_id      AS org_id,
          sr.status      AS status,
          sr.expires_at  AS expires_at,
          GREATEST(
            sr.created_at,
            COALESCE(MAX(ol.created_at) FILTER (WHERE ol.status = 'sent'), sr.created_at)
          )              AS last_contact_at,
          COUNT(ol.id) FILTER (WHERE ol.status = 'sent')::int AS reminders_sent
        FROM signature_requests sr
        LEFT JOIN outbound_ledger ol
          ON ol.org_id = sr.org_id
         AND ol.recipient_ref = sr.id::text
         AND ol.channel IN ('email','sms')
        WHERE sr.status = 'pending'
          AND sr.expires_at > ${ctx.now}
        GROUP BY sr.id, sr.org_id, sr.status, sr.expires_at, sr.created_at
        HAVING GREATEST(
                 sr.created_at,
                 COALESCE(MAX(ol.created_at) FILTER (WHERE ol.status = 'sent'), sr.created_at)
               ) <= ${new Date(ctx.now.getTime() - minCadenceDays * 24 * 60 * 60 * 1000)}
        ORDER BY last_contact_at ASC
        LIMIT 5000
      `);

      const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

      const conditions: DetectedCondition[] = [];
      for (const row of rows) {
        const requestId = String(row['id']);
        const orgId = String(row['org_id']);
        const status = String(row['status']);
        const expiresAtVal = row['expires_at'];
        const lastContactVal = row['last_contact_at'];
        const remindersSent = Number(row['reminders_sent'] ?? 0);

        const expiresAt =
          expiresAtVal instanceof Date ? expiresAtVal : new Date(String(expiresAtVal));
        const lastContactAt =
          lastContactVal instanceof Date ? lastContactVal : new Date(String(lastContactVal));

        // The pure cadence policy — decides DUE + which step. Defensive on
        // status/expiry even though the query pre-filters.
        const decision = decideReminderCadence(
          { status, lastContactAt, remindersSent, expiresAt },
          ctx.now,
        );
        if (!decision.due) continue;

        conditions.push({
          orgId,
          kind: REMINDER_SEND_KIND,
          scopeType: 'signature_request',
          scopeId: requestId,
          // PII-FREE evidence snapshot: ids + cadence facts only.
          evidence: {
            signatureRequestId: requestId,
            cadenceStep: decision.cadenceStep,
            cadenceDays: decision.cadenceDays,
            reminderIndex: remindersSent + 1, // human-facing "reminder N of 3"
            maxReminders: REMINDER_CADENCE_DAYS.length,
            reason: 'no_response_since_last_contact',
          },
          // DETERMINISTIC dedup key per (request, step) — a new step re-proposes.
          dedupKey: `${REMINDER_SEND_KIND}:${requestId}:${decision.cadenceStep}`,
          expiresAt: proposalExpiresAt,
        });
      }

      return conditions;
    },
  };
}
