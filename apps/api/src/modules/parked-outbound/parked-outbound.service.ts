import { AuditService, outboundLedger, withTenant, type OutboundLedgerRow } from '@emapp/db';
import type {
  CountParkedOutboundQueryDto,
  ListParkedOutboundQueryDto,
  ParkedOutboundChannel,
  ParkedOutboundCount,
  ParkedOutboundReason,
  ParkedOutboundView,
  ResolveParkedOutboundInputDto,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

export interface ParkedOutboundListPage {
  data: ParkedOutboundView[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/**
 * PARKED-OUTBOUND ops service (Autonomous Master Plan — the #509 observability
 * gap). A manager-facing surface over the EXISTING `outbound_ledger` table; it
 * adds NO migration and NO new table.
 *
 * It surfaces the two ways an outbound row can sit `pending_send` forever,
 * invisible, never auto-resent (correct for M1 exactly-once, but operationally
 * blind):
 *
 *   - PARKED-AMBIGUOUS — `status='pending_send' AND failure_code IS NOT NULL`.
 *     The provider call THREW / timed out (see `settleAmbiguous` in
 *     outbound-governor.ts). The SMS MAY have gone out, so the autonomous path
 *     NEVER re-sends it. A human must check the provider dashboard.
 *   - STALE-CRASHED — `status='pending_send' AND failure_code IS NULL AND
 *     created_at < now() - staleWindow`. A claim that never settled (the worker
 *     crashed between claim and settle). Also un-resendable by the auto path.
 *
 * Manager-only (every op `requireManager`, mirroring the proposals surface) +
 * RLS isolates every read/write to the manager's org. NO PII: `recipient_ref`
 * is the signature_request id ONLY; we surface ids/channel/failure_code/created_at,
 * never phone/email/owner name.
 *
 * The RESOLVE action is the manager's explicit disambiguation after checking the
 * provider dashboard: `sent` (it did go out → terminal no-op) or `failed` (it
 * did NOT → terminal, RE-CLAIMABLE so the reminder retries per the merged H1
 * logic). Both are atomic, manager-only, audited, and guarded by
 * `WHERE status='pending_send'` so they can NEVER race a concurrent governor
 * settle nor cause a double-send. See `resolve` for the exactly-once reasoning.
 */
@Injectable()
export class ParkedOutboundService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  /** The SQL predicate selecting a row's parked bucket. `now`/`staleMinutes`
   *  define the stale window. Both buckets are `status='pending_send'`; the
   *  failure_code presence splits ambiguous (NOT NULL) from a crashed claim
   *  (NULL, and old). A fresh in-flight claim (NULL, recent) is DELIBERATELY
   *  excluded — it is not yet stuck. */
  private parkedPredicate(opts: { reason?: ParkedOutboundReason; staleBefore: Date }): SQL {
    const ambiguous = and(
      eq(outboundLedger.status, 'pending_send'),
      isNotNull(outboundLedger.failureCode),
    ) as SQL;
    const stale = and(
      eq(outboundLedger.status, 'pending_send'),
      isNull(outboundLedger.failureCode),
      lt(outboundLedger.createdAt, opts.staleBefore),
    ) as SQL;
    if (opts.reason === 'ambiguous') return ambiguous;
    if (opts.reason === 'stale') return stale;
    return or(ambiguous, stale) as SQL;
  }

  /** Classify a row into its bucket for the wire shape. */
  private reasonOf(row: OutboundLedgerRow): ParkedOutboundReason {
    return row.failureCode != null ? 'ambiguous' : 'stale';
  }

  private toView(row: OutboundLedgerRow): ParkedOutboundView {
    return {
      id: row.id,
      reason: this.reasonOf(row),
      channel: row.channel as ParkedOutboundChannel,
      recipientRef: row.recipientRef,
      cadenceStep: row.cadenceStep,
      failureCode: row.failureCode ?? null,
      createdAt: row.createdAt,
    };
  }

  /** List the parked outbound rows needing attention, newest-first, keyset-
   *  paginated (D.16). PII-FREE. RLS isolates to the manager's org. */
  async list(
    user: AccessTokenPayload,
    query: ListParkedOutboundQueryDto,
  ): Promise<ParkedOutboundListPage> {
    this.requireManager(user);
    const { limit, staleMinutes } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const staleBefore = new Date(Date.now() - staleMinutes * 60_000);

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const keyset: SQL | undefined = cur
          ? keysetCondition(outboundLedger.createdAt, outboundLedger.id, cur)
          : undefined;
        return tx
          .select()
          .from(outboundLedger)
          .where(and(this.parkedPredicate({ reason: query.reason, staleBefore }), keyset))
          .orderBy(...keysetOrderBy(outboundLedger.createdAt, outboundLedger.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => this.toView(r)),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  /** Count the parked rows per bucket (the manager's attention badge). RLS-scoped. */
  async count(
    user: AccessTokenPayload,
    query: CountParkedOutboundQueryDto,
  ): Promise<ParkedOutboundCount> {
    this.requireManager(user);
    const staleBefore = new Date(Date.now() - query.staleMinutes * 60_000);

    const counts = await withTenant(
      user.orgId,
      async (tx) => {
        const [ambiguousRow] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(outboundLedger)
          .where(this.parkedPredicate({ reason: 'ambiguous', staleBefore }));
        const [staleRow] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(outboundLedger)
          .where(this.parkedPredicate({ reason: 'stale', staleBefore }));
        return { ambiguous: ambiguousRow?.n ?? 0, stale: staleRow?.n ?? 0 };
      },
      { userId: user.sub },
    );
    return { ...counts, total: counts.ambiguous + counts.stale };
  }

  /**
   * RESOLVE a parked row — the manager's explicit disambiguation after checking
   * the provider dashboard. Atomic, manager-only, audited.
   *
   * EXACTLY-ONCE SAFETY (the crux):
   *   - Both transitions are guarded `WHERE status='pending_send'`, so a resolve
   *     can NEVER race a concurrent governor settle (the governor only ever flips
   *     a `pending_send` row; whichever runs first wins, the loser updates 0 rows
   *     and 409s) and can NEVER touch an already-terminal `sent`/`failed` row.
   *   - `outcome='sent'` flips the row → TERMINAL `sent`. This is a DELIVERY
   *     NO-OP: the send already happened; we only record the truth so the row
   *     stops nagging. It triggers NO provider call — `resolve` never sends. A
   *     terminal `sent` row remains the exactly-once anchor: any re-proposal of
   *     the same (recipient, step) collides on the UNIQUE key and the governor's
   *     pre-check returns `already_sent`. So resolve→sent canNOT cause a re-send.
   *   - `outcome='failed'` flips the row → TERMINAL `failed`, which the Governor
   *     CAN re-claim on the next approve (#506 H1) → the reminder retries the SAME
   *     step. This is the ONLY transition that re-enables sending, and it re-sends
   *     through the FULL governed path (gates + a fresh claim), NEVER from here.
   *     The manager picks it ONLY when the dashboard shows the message did not
   *     dispatch; the controller/DTO force the explicit yes/no so a wrong `failed`
   *     on a row that actually SENT can't silently slip through.
   *
   * Returns the resolved row's view (with its NEW terminal status reflected in
   * `reason`-free fields). A non-`pending_send` row 409s `parked_not_pending`.
   */
  async resolve(
    user: AccessTokenPayload,
    id: string,
    body: ResolveParkedOutboundInputDto,
  ): Promise<{ id: string; status: 'sent' | 'failed' }> {
    this.requireManager(user);

    return withTenant(
      user.orgId,
      async (tx) => {
        // Load the row (RLS-scoped) — must exist + be a parked `pending_send`.
        const [existing] = await tx
          .select({ id: outboundLedger.id, status: outboundLedger.status })
          .from(outboundLedger)
          .where(eq(outboundLedger.id, id))
          .limit(1);
        if (!existing) throw NOT_FOUND;
        if (existing.status !== 'pending_send') {
          // Already terminal (a concurrent settle/resolve, or never parked).
          throw new ConflictException({ error: { code: 'parked_not_pending' } });
        }

        // Atomic, status-guarded terminal flip. `WHERE status='pending_send'`
        // makes it race-safe against a concurrent governor settle: exactly one
        // writer flips the row; the other matches 0 rows and 409s below.
        const [row] = await tx
          .update(outboundLedger)
          .set({ status: body.outcome, settledAt: new Date() })
          .where(and(eq(outboundLedger.id, id), eq(outboundLedger.status, 'pending_send')))
          .returning({ id: outboundLedger.id });
        if (!row) {
          throw new ConflictException({ error: { code: 'parked_not_pending' } });
        }

        // Audit every manual disambiguation (forensic: who decided what, when).
        // NO PII in metadata — only the outcome + the NON-PII recipient handle.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'parked_outbound.resolve',
          targetTable: 'outbound_ledger',
          targetId: row.id,
          metadata: { outcome: body.outcome },
          sessionId: user.sid,
        });

        return { id: row.id, status: body.outcome };
      },
      { userId: user.sub },
    );
  }
}
