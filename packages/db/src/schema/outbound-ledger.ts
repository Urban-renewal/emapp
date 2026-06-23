import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

import { proposals } from './proposals';
import { organizations } from './tenancy';

/**
 * `outbound_ledger` — the M1 EXACTLY-ONCE outbound spine (Autonomous Master
 * Plan, Phase 2; design correction M1).
 *
 * One row per governed outbound SEND attempt. The OutboundGovernor CLAIMS a row
 * (insert `pending_send`) BEFORE calling the provider, keyed by a DETERMINISTIC
 * idempotency key, then flips it to a terminal state (`sent`/`failed`).
 *
 * ── M1 — why a UNIQUE key + state machine, not "ledger before send" ──────────
 * idempotency_key = recipient_ref + cadence_step (org scope comes from the
 * (org_id, idempotency_key) UNIQUE — proposal_id is DELIBERATELY NOT in the key;
 * see below). The FULL UNIQUE on (org_id, idempotency_key) means a double-approve,
 * a retry-after-ambiguous-failure, OR a RE-PROPOSAL of the same recipient+step
 * CLAIMS the SAME key, collides, finds the prior row, and — on a terminal `sent`
 * OR a parked `pending_send` — NO-OPs the replay rather than blind-resending.
 * "Ledger before send" alone only gives attempt-durability; the UNIQUE key + the
 * pending_send→sent→failed state machine is what guarantees exactly-once.
 * Mirrors the proven `import_jobs.idempotency_key` UNIQUE idiom.
 *
 * ── Why `proposal_id` is NOT in the key (round-2 cross-proposal red-team) ─────
 * The exactly-once UNIT is "one send per (org, recipient, cadence-step)", NOT
 * "per proposal". A parked AMBIGUOUS send leaves a `pending_send` row; if the
 * triggering proposal then leaves `pending` (REJECT releases the dedup key, or
 * EXPIRE via recommender TTL), the recommender re-proposes the SAME (recipient,
 * step) as a NEW proposal. Had proposal_id been in the key, that new proposal's
 * claim would NOT collide → a SECOND real SMS for a possibly-already-dispatched
 * message. Keying on (recipient_ref, cadence_step) makes the re-proposal collide
 * with the parked row → already_sent → no double-send. proposal_id is kept as a
 * NON-KEY causal column (which proposal drove the send — audit/trace only).
 *
 * Unlike the proposals partial-unique (releases on non-pending), this is a FULL
 * unique across ALL states: a terminal `sent` row MUST keep occupying the key so
 * a replay collides instead of re-sending.
 *
 * ── NO PII ──────────────────────────────────────────────────────────────────
 * `recipient_ref` is a STABLE NON-PII handle (the signature_request id the
 * reminder targets), NEVER the owner's email/phone. The address is resolved at
 * send time from the gated domain method and never persisted here. `failure_code`
 * is a generic code, never the provider's raw error text.
 *
 * ── RLS posture (mirrors proposals/0080 + every tenant table) ────────────────
 * FORCE + org-isolation on the `app.organization_id` GUC; the governor writes
 * per-tenant inside withTenant. No BYPASSRLS app path. See migration 0081.
 */
export const outboundLedger = pgTable(
  'outbound_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The proposal whose APPROVE drove this send (causal + idempotency link). */
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'restrict' }),
    /** 'email' | 'sms' (CHECK-pinned). The channel the send went out on. */
    channel: text('channel').notNull(),
    /** NON-PII recipient discriminator (the signature_request id) — never the
     *  owner's email/phone. Part of the idempotency key. */
    recipientRef: text('recipient_ref').notNull(),
    /** Cadence step (0/+3/+7/+14 → 0,1,2,3). A new step → a new key → a distinct
     *  send; a retry of the same step collides on the UNIQUE key. */
    cadenceStep: integer('cadence_step').notNull(),
    /** DETERMINISTIC idempotency key = recipientRef + cadenceStep (NOT proposalId
     *  — the exactly-once unit is per recipient+step, stable across re-proposals;
     *  see the header). UNIQUE per org. The M1 root. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** pending_send | sent | failed (CHECK-pinned). The state machine. */
    status: text('status').notNull().default('pending_send'),
    /** Provider message id on success (NON-PII opaque handle). */
    providerMessageId: text('provider_message_id'),
    /** Generic failure code on failure (NO PII, NO provider raw error text). */
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the row reaches a terminal state (sent/failed). */
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => ({
    // M1 — the exactly-once UNIQUE. FULL (all states), per org.
    idemUnique: uniqueIndex('outbound_ledger_org_idem_unique').on(
      table.orgId,
      table.idempotencyKey,
    ),
    // "did this proposal already send?" lookup.
    orgProposalIdx: index('idx_outbound_ledger_org_proposal').on(table.orgId, table.proposalId),
    // RateCeilingGate window scan (recent rows per org/recipient).
    orgRecipientCreatedIdx: index('idx_outbound_ledger_org_recipient_created').on(
      table.orgId,
      table.recipientRef,
      table.createdAt.desc(),
    ),
  }),
);

export type OutboundLedgerRow = typeof outboundLedger.$inferSelect;
export type NewOutboundLedgerRow = typeof outboundLedger.$inferInsert;

/** The channels a governed outbound can use. */
export const OUTBOUND_CHANNELS = ['email', 'sms'] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

/** The ledger state machine. `pending_send` is the claimed-not-yet-settled
 *  state; `sent`/`failed` are terminal. Mirrors the CHECK in migration 0081. */
export const OUTBOUND_LEDGER_STATUSES = ['pending_send', 'sent', 'failed'] as const;
export type OutboundLedgerStatus = (typeof OUTBOUND_LEDGER_STATUSES)[number];
