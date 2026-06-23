import { z } from 'zod';

// Autonomous Master Plan — PARKED-OUTBOUND ops surface (the #509 red-team
// observability gap). A manager-facing read over the EXISTING `outbound_ledger`
// table that surfaces the outbound rows needing HUMAN attention:
//
//   - PARKED-AMBIGUOUS: status='pending_send' AND failure_code IS NOT NULL — a
//     reminder send whose provider call THREW / timed out. The SMS MAY have
//     actually gone out, so it is NEVER auto-resent (M1 exactly-once). It sits
//     invisibly until a human checks the provider dashboard + disambiguates.
//   - STALE-CRASHED: status='pending_send' AND failure_code IS NULL AND old —
//     a claim that never settled (the worker crashed mid-flight between claim
//     and settle). Also un-resendable by the autonomous path until resolved.
//
// ── NO PII ──────────────────────────────────────────────────────────────────
// `recipientRef` is the signature_request id ONLY (the stable NON-PII handle the
// ledger persists) — NEVER the owner's phone/email/name. The wire shape carries
// ids / channel / failure_code / timestamps — enough for a human to FIND the
// row in the provider dashboard, never the recipient's address.
//
// VOICE LAW (owner-mandated): user-facing copy frames the USER's pending check
// ("תזכורת אולי נשלחה — נדרשת בדיקה ידנית"), NEVER a system-hero "I sent". The
// wire shape is neutral data; the FE composes the calm copy from it.

/** Why a parked row needs attention. `ambiguous` = the provider threw/timed out
 *  (maybe-sent); `stale` = a claim that never settled (crashed mid-flight). */
export const ParkedOutboundReasonEnum = z.enum(['ambiguous', 'stale']);
export type ParkedOutboundReason = z.infer<typeof ParkedOutboundReasonEnum>;

/** Outbound channel the parked send went out on (or would have). */
export const ParkedOutboundChannelEnum = z.enum(['email', 'sms']);
export type ParkedOutboundChannel = z.infer<typeof ParkedOutboundChannelEnum>;

/** Manager-side wire shape for one parked outbound row. PII-FREE by contract:
 *  `recipientRef` is the signature_request id, never an address. */
export const ParkedOutboundSchema = z.object({
  /** The ledger row id — the handle the resolve action targets. */
  id: z.string().uuid(),
  /** WHY it is parked (ambiguous = maybe-sent; stale = never-settled claim). */
  reason: ParkedOutboundReasonEnum,
  /** The channel the send used (sms/email). */
  channel: ParkedOutboundChannelEnum,
  /** The signature_request id the reminder targeted — NON-PII; the handle a
   *  human uses to find the recipient in-app, never the phone/email itself. */
  recipientRef: z.string(),
  /** Which cadence step (0/+3/+7/+14 → 0..3). */
  cadenceStep: z.number().int().min(0),
  /** Generic NON-PII failure code (e.g. 'send_threw'); null for a stale claim. */
  failureCode: z.string().nullable(),
  /** When the row was claimed (UTC; FE displays Asia/Jerusalem). */
  createdAt: z.coerce.date(),
});
export type ParkedOutboundView = z.infer<typeof ParkedOutboundSchema>;

/** GET /api/v1/parked-outbound query — keyset-paginated, optional reason filter.
 *  `staleMinutes` overrides the stale-crashed window (default 15m). */
export const ListParkedOutboundQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  /** Narrow to one bucket (ambiguous-only or stale-only). Omit = both. */
  reason: ParkedOutboundReasonEnum.optional(),
  /** The stale-crashed window in minutes — a claim older than this with no
   *  failure_code is surfaced as `stale`. Bounded 1..1440 (default 15). */
  staleMinutes: z.coerce.number().int().min(1).max(1440).default(15),
});
export type ListParkedOutboundQueryDto = z.infer<typeof ListParkedOutboundQuery>;

/** GET /api/v1/parked-outbound/count — same buckets, no pagination. Returns the
 *  counts for the manager's attention badge. */
export const CountParkedOutboundQuery = z.object({
  staleMinutes: z.coerce.number().int().min(1).max(1440).default(15),
});
export type CountParkedOutboundQueryDto = z.infer<typeof CountParkedOutboundQuery>;

export const ParkedOutboundCountSchema = z.object({
  ambiguous: z.number().int().min(0),
  stale: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type ParkedOutboundCount = z.infer<typeof ParkedOutboundCountSchema>;

/**
 * POST /api/v1/parked-outbound/:id/resolve body — the manager's EXPLICIT
 * disambiguation after checking the provider dashboard.
 *
 * EXACTLY-ONCE SAFETY (the whole point): the manager MUST state whether the SMS
 * actually went out. The two outcomes are deliberately ASYMMETRIC:
 *   - `sent`  — "it DID go out" → settle the row TERMINAL `sent`. This is a
 *               no-op for delivery (it already happened); it merely records the
 *               truth so the row stops nagging. It NEVER triggers a re-send (a
 *               terminal `sent` row is the exactly-once anchor).
 *   - `failed`— "it did NOT go out" → settle TERMINAL `failed`, which the
 *               Governor can RE-CLAIM on the next approve → the reminder retries
 *               the SAME step (per the merged H1 logic). Choose this ONLY when
 *               the provider dashboard shows the message did not dispatch — a
 *               wrong `failed` on a row that actually SENT would enable a DOUBLE
 *               SMS. The UI makes the choice explicit ("did it send? yes/no").
 */
export const ResolveParkedOutboundInput = z.object({
  /** The manager's verdict from the provider dashboard. `sent` = it went out
   *  (terminal no-op); `failed` = it did NOT (terminal, re-claimable retry). */
  outcome: z.enum(['sent', 'failed']),
});
export type ResolveParkedOutboundInputDto = z.infer<typeof ResolveParkedOutboundInput>;
