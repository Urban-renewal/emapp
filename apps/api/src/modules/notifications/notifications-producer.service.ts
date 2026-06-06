import { notifications, withTenant } from '@emapp/db';
import type { NotificationType } from '@emapp/shared-types';
import { Injectable, Logger } from '@nestjs/common';

export interface NotificationEmitInput {
  /** Target org. Becomes app.organization_id for the producing tx. */
  orgId: string;
  /** Target user. Becomes app.user_id so the self-scoped WITH CHECK passes. */
  recipientId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Server-side notification PRODUCER — the generation half that was
 * deferred at Phase 3 Slice 7 (see NotificationsService header).
 *
 * The locked notifications RLS policy is BOTH org- and self-scoped:
 *   USING / WITH CHECK (org_id = app.organization_id
 *                       AND user_id = app.user_id)
 * so a row may be inserted ONLY when app.user_id equals the row's
 * recipient. We therefore open the producing transaction scoped to the
 * RECIPIENT — `withTenant(orgId, fn, { userId: recipientId })` — which
 * sets app.user_id to the recipient and lets the INSERT satisfy the
 * existing WITH CHECK WITHOUT any policy/migration change (no Gate-6).
 *
 * emit() is best-effort and fully isolated: a notification failure MUST
 * NEVER fail the business action that triggered it. emit() self-guards
 * (catches + logs) and returns a boolean so callers can fire-and-forget.
 *
 * PII rule: titles/bodies are stored UNENCRYPTED. Callers MUST NOT pass
 * national_id, phone, or signature material. Same-org, already-visible
 * labels (document name, apartment number) are fine.
 *
 * CALLER INVARIANT: `recipientId` MUST be a user that belongs to `orgId`.
 * The notifications FK enforces user existence but NOT org membership, and
 * the RLS WITH CHECK only pins the row's (org_id,user_id) to the GUCs we
 * set here — it cannot validate the pair is coherent. Resolve `recipientId`
 * from a read already scoped to `orgId` (e.g. an org-scoped withTenant
 * SELECT) so a mismatched pair can never be constructed. A mis-targeted
 * row is harmless (invisible to the wrong-org user, whose session GUCs
 * never match) but is dead data — keep the invariant at the source.
 */
@Injectable()
export class NotificationsProducerService {
  private readonly logger = new Logger(NotificationsProducerService.name);

  async emit(input: NotificationEmitInput): Promise<boolean> {
    try {
      await withTenant(
        input.orgId,
        async (tx) => {
          await tx.insert(notifications).values({
            orgId: input.orgId,
            userId: input.recipientId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
            metadata: input.metadata ?? {},
          });
        },
        { userId: input.recipientId },
      );
      return true;
    } catch (e: unknown) {
      this.logger.error(
        `emit failed (type=${input.type} recipient=${input.recipientId}): ${
          e instanceof Error ? e.message : 'unknown'
        }`,
      );
      return false;
    }
  }

  /**
   * Fan-out the SAME notification to multiple distinct recipients
   * (e.g. all stakeholders of a project). Deduplicates recipientIds and
   * drops falsy entries. Returns the count actually delivered.
   */
  async emitMany(
    recipientIds: readonly string[],
    base: Omit<NotificationEmitInput, 'recipientId'>,
  ): Promise<number> {
    const unique = [...new Set(recipientIds)].filter(Boolean);
    let delivered = 0;
    for (const recipientId of unique) {
      // Sequential on purpose: each recipient is a short, isolated tx;
      // a single failure must not abort the rest (emit self-guards).
      // eslint-disable-next-line no-await-in-loop
      if (await this.emit({ ...base, recipientId })) delivered += 1;
    }
    return delivered;
  }
}
