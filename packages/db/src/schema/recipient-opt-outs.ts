import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { owners } from './projects';
import { organizations } from './tenancy';

/**
 * `recipient_opt_outs` — the autonomy outbound CONSENT / OPT-OUT registry (M2;
 * #506 reminder-cadence red-team MEDIUM finding).
 *
 * One durable row per (org, owner, channel): "this recipient opted out of
 * outbound on this channel". The OutboundGovernor's `ConsentGate` reads this
 * table — a matching opt-out (the send's channel OR `all`) resolves
 * `recipientConsented=false` → the gate DENIES the send. Until M2 that input was
 * a hard-coded `true`; this registry is what makes it real.
 *
 * ── KEYED ON THE OWNER (the person), NOT the signature_request ───────────────
 * The outbound `recipient_ref` is the signature_request id, but an opt-out is a
 * property of the PERSON: a resident who opts out must stop receiving reminders
 * for EVERY pending request, present + future. So the registry keys on
 * `owner_id`; the gate resolves signature_request → owner_id → this table.
 *
 * ── NO PII ───────────────────────────────────────────────────────────────────
 * Only the owner FK + channel + provenance. NEVER the raw phone/email the opt-
 * out came from (that PII lives encrypted on the owner row). `source` is a
 * generic enum, never a free-text address.
 *
 * ── DURABLE (legal) ──────────────────────────────────────────────────────────
 * An opt-out is a legal record of a withdrawn consent. DELETE is REVOKED from
 * app_user (migration 0083); a re-opt-in (if ever built) is an UPDATE, not a
 * physical delete.
 *
 * ── RLS posture (mirrors outbound_ledger/0081) ───────────────────────────────
 * FORCE + org-isolation on `app.organization_id`; resolved/written per-tenant
 * inside withTenant. See migration 0083.
 */
export const recipientOptOuts = pgTable(
  'recipient_opt_outs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The recipient who opted out — the PERSON (owner), not one signature
     *  request. The gate resolves a signature_request to its owner_id. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    /** 'email' | 'sms' | 'all' (CHECK-pinned). 'all' opts out of every channel. */
    channel: text('channel').notNull(),
    /** When the opt-out took effect (durable). */
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }).notNull().defaultNow(),
    /** Provenance (NON-PII): how the opt-out was recorded. */
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotent opt-out per owner+channel + the index the ConsentGate's
    // resolution query rides ("(org, owner) on channel-or-all?").
    orgOwnerChannelUnique: uniqueIndex('recipient_opt_outs_org_owner_channel_unique').on(
      table.orgId,
      table.ownerId,
      table.channel,
    ),
  }),
);

export type RecipientOptOutRow = typeof recipientOptOuts.$inferSelect;
export type NewRecipientOptOutRow = typeof recipientOptOuts.$inferInsert;

/** The channels an opt-out can scope. `all` is the wildcard that suppresses
 *  every outbound channel. */
export const OPT_OUT_CHANNELS = ['email', 'sms', 'all'] as const;
export type OptOutChannel = (typeof OPT_OUT_CHANNELS)[number];

/** How an opt-out was recorded (provenance). */
export const OPT_OUT_SOURCES = ['unsubscribe_link', 'manager', 'provider_stop'] as const;
export type OptOutSource = (typeof OPT_OUT_SOURCES)[number];
