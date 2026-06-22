import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

import { organizations } from './tenancy';

/**
 * `proposals` — the Approval-Inbox SPINE (Autonomous Master Plan, Phase 1).
 *
 * One org-scoped row per autonomous DRAFT awaiting a human's one-click confirm.
 * A recommender DETECTS a condition; the generic producer SNAPSHOTS the evidence
 * and writes a `pending` proposal here via `emitProposal()` (the single insert
 * path). The manager sees it in the Approval Inbox and APPROVES / REJECTS it.
 * APPROVE re-asserts the boundary (`classify(kind)` at execute time) and replays
 * the EXISTING gated domain method — a proposal can never do something a human
 * could not do through the normal UI.
 *
 * ── Why the columns are shaped this way ─────────────────────────────────────
 * - `kind`            — the AutonomyPolicy action kind. `emitProposal` calls
 *                       `classify(kind)`; an unclassifiable kind THROWS (the
 *                       taxonomy is the single chokepoint, never bypassed here).
 * - `status`          — pending | approved | rejected | expired | applied.
 *                       CHECK-pinned. `pending` is the only actionable state.
 * - `scopeType`/`scopeId` — what the proposal is ABOUT (a project / owner /
 *                       signature_request / etc.) so the inbox can group + the
 *                       executor can address the target. Never PII.
 * - `evidence`        — the snapshot taken AT EMIT (design correction: evidence
 *                       is frozen, NOT recomputed on read), so the manager
 *                       confirms against what the system saw, and a stale read
 *                       can't silently change the displayed justification. PII
 *                       MUST NOT be placed here (ids/counts only — the same
 *                       PII-free-title contract as notifications).
 * - `dedupKey`        — idempotency key. A producer derives a DETERMINISTIC key
 *                       per detected condition; the partial UNIQUE below makes a
 *                       second live emit a no-op so a producer can't nag/duplicate.
 * - `expiresAt`       — retires a stale proposal (the inbox never accumulates).
 * - `actorType`       — always 'system' in Phase 1 (the engine authored it).
 * - `appliedAt`       — set when APPROVE successfully replays the gated method.
 *
 * ── The idempotency invariant (the heart of the spine) ──────────────────────
 * `UNIQUE(org_id, dedup_key) WHERE status = 'pending'` — a producer that runs
 * twice (overlapping ticks, retry) cannot create two LIVE proposals for the same
 * condition. Once a proposal leaves `pending` (approved/rejected/expired/applied)
 * the partial index releases the key, so the SAME condition recurring later can
 * legitimately re-propose. This is a PARTIAL unique index (Drizzle `.where`),
 * mirroring the proven `import_jobs.idempotency_key`-style idiom.
 *
 * ── RLS posture (mirrors every other tenant table) ──────────────────────────
 * RLS FORCE + an org-isolation policy keyed on the `app.organization_id` GUC.
 * The producer writes per-tenant inside `withTenant(orgId, …)`; the inbox read +
 * approve run under the manager's `withTenant`. There is NO BYPASSRLS app path —
 * the only system writer (the producer) still scopes per-org. See migration 0080.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** AutonomyPolicy action kind (e.g. 'signature_request.reissue'). Classified
     *  by `emitProposal` — an unknown kind throws before any insert. */
    kind: text('kind').notNull(),
    /** pending | approved | rejected | expired | applied (CHECK-pinned). */
    status: text('status').notNull().default('pending'),
    /** The kind of entity this proposal is about ('project' | 'owner' |
     *  'signature_request' | …). Free text — the executor interprets it per kind. */
    scopeType: text('scope_type').notNull(),
    /** The concrete entity id the proposal targets (in-org; RLS-isolated). */
    scopeId: uuid('scope_id').notNull(),
    /** Evidence SNAPSHOT taken at emit (NOT recomputed on read). ids/counts only
     *  — never PII (national_id/phone/name). */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    /** Deterministic idempotency key. Partial-UNIQUE per org WHERE pending. */
    dedupKey: text('dedup_key').notNull(),
    /** Retires a stale pending proposal so the inbox never accumulates noise. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Always 'system' in Phase 1 — the engine authored this draft. */
    actorType: text('actor_type').notNull().default('system'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when APPROVE successfully replays the gated domain method. */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => ({
    // The idempotency invariant — at most ONE live (pending) proposal per
    // (org, dedup_key). Releases the key once the proposal leaves pending.
    dedupPendingUnique: uniqueIndex('proposals_org_dedup_pending_unique')
      .on(table.orgId, table.dedupKey)
      .where(sql`status = 'pending'`),
    // Inbox list / keyset pagination over pending proposals, newest first.
    orgPendingIdx: index('idx_proposals_org_pending')
      .on(table.orgId, table.createdAt.desc(), table.id.desc())
      .where(sql`status = 'pending'`),
    // The expiry sweep predicate (pending + past expires_at).
    pendingExpiryIdx: index('idx_proposals_pending_expiry')
      .on(table.expiresAt)
      .where(sql`status = 'pending'`),
  }),
);

export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;

/** The lifecycle states a proposal can occupy. `pending` is the only actionable
 *  one; the rest are terminal-ish (expired/rejected/applied) or post-confirm
 *  (approved → applied). Mirrors the CHECK in migration 0080. */
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'applied'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
