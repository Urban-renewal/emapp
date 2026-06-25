import { randomUUID } from 'node:crypto';

import {
  AuditService,
  conversationParticipants,
  conversations,
  memberships,
  messages,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { Conversation, CreateConversation, Message } from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { notificationLink } from '../notifications/notification-links';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

export interface ConversationListPage {
  data: Conversation[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export interface MessageListPage {
  data: Message[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });
const INVALID_PARTICIPANT = new BadRequestException({ error: { code: 'invalid_participant' } });

function toMessage(r: typeof messages.$inferSelect): Message {
  return {
    id: r.id,
    conversationId: r.conversationId,
    senderId: r.senderId,
    body: r.body,
    createdAt: r.createdAt,
  };
}

/**
 * Team messaging domain service — internal member ↔ member conversations.
 *
 * Authorization model (NOT the IAM capability matrix — see migration 0075):
 *  - Org isolation is the RLS hard boundary on all three tables.
 *  - PARTICIPATION is the per-record boundary: `conversations` + `messages` are
 *    RLS-scoped to the requesting member's participations (a non-participant's
 *    SELECT returns nothing → we surface a no-oracle 404). The WITH CHECK on
 *    `messages` also enforces "only a participant may post" at the DB level.
 *  - VIEWER is read-only: may list/read conversations + messages it participates
 *    in, but may NOT create a conversation or send a message (enforced here,
 *    before any write — mirrors the notes viewer-forbidden posture).
 *
 * Message bodies are member-internal collaboration text (NOT PII national_id/
 * phone/signatures); they are never logged and never placed in notifications.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(private readonly notifications: NotificationsProducerService) {}

  /**
   * Fan out a `message_received` notification to the OTHER participants of a
   * conversation — best-effort, AFTER commit. The message body is member-
   * internal and is NEVER placed in the notification: only a generic title +
   * the deep-link to the thread (the recipient opens it to read the content
   * through the normal RLS-scoped path). A notify failure must never fail the
   * send (self-guarded + try/catch — mirrors the notes note_added posture).
   */
  private async notifyParticipants(
    orgId: string,
    conversationId: string,
    recipientIds: readonly string[],
  ): Promise<void> {
    if (recipientIds.length === 0) return;
    try {
      await this.notifications.emitMany(recipientIds, {
        orgId,
        type: 'message_received',
        title: 'הודעה חדשה',
        body: null,
        link: notificationLink.message(conversationId),
        metadata: { conversationId },
      });
    } catch (e) {
      this.logger.error(
        `message_received notify failed (conv=${conversationId}): ${
          e instanceof Error ? e.message : 'unknown'
        }`,
      );
    }
  }

  /**
   * Enrich raw conversation rows with the per-member view: the participant id
   * list, the latest-message preview, and the member-relative unread count.
   * Three bounded set-based queries (no N+1); empty input short-circuits.
   */
  private async enrich(
    tx: TenantTx,
    userSub: string,
    rows: (typeof conversations.$inferSelect)[],
  ): Promise<Conversation[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((c) => c.id);

    // Participants of every conversation on the page (one query).
    const parts = await tx
      .select({
        conversationId: conversationParticipants.conversationId,
        userId: conversationParticipants.userId,
      })
      .from(conversationParticipants)
      .where(inArray(conversationParticipants.conversationId, ids));
    const partMap = new Map<string, string[]>();
    for (const p of parts) {
      const arr = partMap.get(p.conversationId);
      if (arr) arr.push(p.userId);
      else partMap.set(p.conversationId, [p.userId]);
    }

    // Latest message per conversation (DISTINCT ON — one query).
    const lastRows = await tx
      .selectDistinctOn([messages.conversationId], {
        conversationId: messages.conversationId,
        id: messages.id,
        senderId: messages.senderId,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.conversationId, ids))
      .orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.id));
    const lastMap = new Map(
      lastRows.map((m) => [
        m.conversationId,
        { id: m.id, senderId: m.senderId, body: m.body, createdAt: m.createdAt },
      ]),
    );

    // Unread = messages NOT mine, newer than my last_read_at (one grouped query
    // joining my participant row for the per-conversation read watermark).
    const unreadRows = await tx
      .select({
        conversationId: messages.conversationId,
        count: sql<number>`count(*)::int`,
      })
      .from(messages)
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, messages.conversationId),
          eq(conversationParticipants.userId, userSub),
        ),
      )
      .where(
        and(
          inArray(messages.conversationId, ids),
          ne(messages.senderId, userSub),
          or(
            isNull(conversationParticipants.lastReadAt),
            gt(messages.createdAt, conversationParticipants.lastReadAt),
          ),
        ),
      )
      .groupBy(messages.conversationId);
    const unreadMap = new Map(unreadRows.map((r) => [r.conversationId, Number(r.count)]));

    return rows.map((c) => ({
      id: c.id,
      organizationId: c.orgId,
      title: c.title,
      createdBy: c.createdBy,
      participantIds: partMap.get(c.id) ?? [],
      lastMessage: lastMap.get(c.id) ?? null,
      unreadCount: unreadMap.get(c.id) ?? 0,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      archivedAt: c.archivedAt,
    }));
  }

  /**
   * The TRUE org-wide unread total for the caller — the count of messages, across
   * EVERY conversation the caller participates in, that are NOT theirs and are
   * newer than their per-conversation `last_read_at` watermark (NULL = never
   * opened → all the OTHER party's messages count).
   *
   * Mirrors `NotificationsService.unreadCount`: a single set-based aggregate, NOT
   * a per-conversation N+1 sum. It is the SAME watermark predicate `enrich` uses
   * for the per-row badge (ONE source of truth for "unread"), just unscoped to a
   * page — so the future nav badge shows the real org-wide total at scale, never
   * the page-local sum of the ≤25 rows the list happened to load.
   *
   * Constant work per caller: the `messages` RLS policy already participant-scopes
   * the scan to the caller's threads, the INNER JOIN onto their own participant
   * row (unique index `(conversation_id, user_id)`) supplies the watermark, and
   * `idx_messages_conversation_created` covers the per-conversation recency filter.
   * No `inArray(ids)` page restriction — it counts the whole participated set.
   */
  async unreadCount(user: AccessTokenPayload): Promise<{ count: number }> {
    const result = await withTenant(
      user.orgId,
      async (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(messages)
          .innerJoin(
            conversationParticipants,
            and(
              eq(conversationParticipants.conversationId, messages.conversationId),
              eq(conversationParticipants.userId, user.sub),
            ),
          )
          .where(
            and(
              ne(messages.senderId, user.sub),
              or(
                isNull(conversationParticipants.lastReadAt),
                gt(messages.createdAt, conversationParticipants.lastReadAt),
              ),
            ),
          ),
      { userId: user.sub },
    );
    return { count: result[0]?.count ?? 0 };
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<ConversationListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    return withTenant(
      user.orgId,
      async (tx) => {
        // RLS scopes `conversations` to threads the caller participates in.
        const rows = await tx
          .select()
          .from(conversations)
          .where(
            and(
              isNull(conversations.archivedAt),
              cur ? keysetCondition(conversations.lastMessageAt, conversations.id, cur) : undefined,
            ),
          )
          .orderBy(...keysetOrderBy(conversations.lastMessageAt, conversations.id))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const last = pageRows[pageRows.length - 1];
        const data = await this.enrich(tx, user.sub, pageRows);
        return {
          data,
          page: {
            limit,
            cursor:
              hasMore && last ? encodeCursor({ createdAt: last.lastMessageAt, id: last.id }) : null,
            has_more: hasMore,
          },
        };
      },
      { userId: user.sub },
    );
  }

  async get(user: AccessTokenPayload, id: string): Promise<Conversation> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // RLS hides a thread the caller is not in → no-oracle 404.
        const [row] = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, id))
          .limit(1);
        if (!row) throw NOT_FOUND;
        const [enriched] = await this.enrich(tx, user.sub, [row]);
        if (!enriched) throw NOT_FOUND;
        return enriched;
      },
      { userId: user.sub },
    );
  }

  async create(user: AccessTokenPayload, input: CreateConversation): Promise<Conversation> {
    if (user.role === 'viewer') throw FORBIDDEN;

    // Set inside the tx only if a first message is actually sent; the
    // message_received fan-out then runs AFTER commit (best-effort).
    let notifyRecipients: string[] = [];
    let notifyConversationId = '';
    const created = await withTenant(
      user.orgId,
      async (tx) => {
        // Validate every named participant is an ACTIVE member of this org —
        // you can only start a thread with real teammates. The creator is added
        // implicitly and need not be in the input.
        const named = [...new Set(input.participantIds)].filter((id) => id !== user.sub);
        if (named.length > 0) {
          const memberRows = await tx
            .select({ userId: memberships.userId })
            .from(memberships)
            .where(
              and(
                eq(memberships.orgId, user.orgId),
                isNull(memberships.revokedAt),
                // "active member" = accepted the invite (the canonical predicate,
                // members.service.ts) — a pending invitee must not be addable to
                // a private thread before they have joined the org.
                isNotNull(memberships.acceptedAt),
                inArray(memberships.userId, named),
              ),
            );
          const valid = new Set(memberRows.map((r) => r.userId));
          for (const id of named) if (!valid.has(id)) throw INVALID_PARTICIPANT;
        }

        const now = new Date();
        // Client-generated id + NO `RETURNING`: a participant-scoped USING
        // policy is applied to an INSERT's RETURNING rows, and the creator is
        // not a participant yet (participant rows are written next) — so a
        // RETURNING here would fail the row-level read. We instead generate the
        // id, insert (org-only WITH CHECK passes), then write the participant
        // rows; the row object is built in memory for the response.
        const convId = randomUUID();
        await tx.insert(conversations).values({
          id: convId,
          orgId: user.orgId,
          title: input.title ?? null,
          createdBy: user.sub,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        });

        // Participants = creator (read up to now) ∪ named members (unread).
        const participantSet = new Set<string>([user.sub, ...named]);
        await tx.insert(conversationParticipants).values(
          [...participantSet].map((uid) => ({
            orgId: user.orgId,
            conversationId: convId,
            userId: uid,
            lastReadAt: uid === user.sub ? now : null,
          })),
        );

        // Optional first message (atomic with the thread; participant rows now
        // exist so the messages WITH CHECK passes). Its arrival notifies the
        // other participants after commit.
        if (input.body) {
          await tx.insert(messages).values({
            orgId: user.orgId,
            conversationId: convId,
            senderId: user.sub,
            body: input.body,
          });
          notifyRecipients = named;
          notifyConversationId = convId;
        }

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'conversation.create',
          targetTable: 'conversations',
          targetId: convId,
          sessionId: user.sid,
        });

        const convRow: typeof conversations.$inferSelect = {
          id: convId,
          orgId: user.orgId,
          title: input.title ?? null,
          createdBy: user.sub,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };
        const [enriched] = await this.enrich(tx, user.sub, [convRow]);
        if (!enriched) {
          throw new InternalServerErrorException({
            error: { code: 'insert_no_row', message: 'unexpected db state' },
          });
        }
        return enriched;
      },
      { userId: user.sub },
    );
    await this.notifyParticipants(user.orgId, notifyConversationId, notifyRecipients);
    return created;
  }

  async listMessages(
    user: AccessTokenPayload,
    conversationId: string,
    query: { limit: number; cursor?: string },
  ): Promise<MessageListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    return withTenant(
      user.orgId,
      async (tx) => {
        // RLS hides a thread (and its messages) the caller is not in → 404.
        const [conv] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        if (!conv) throw NOT_FOUND;

        const rows = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              cur ? keysetCondition(messages.createdAt, messages.id, cur) : undefined,
            ),
          )
          .orderBy(...keysetOrderBy(messages.createdAt, messages.id))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = pageRows[pageRows.length - 1];
        return {
          data: pageRows.map(toMessage),
          page: {
            limit,
            cursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
            has_more: hasMore,
          },
        };
      },
      { userId: user.sub },
    );
  }

  async sendMessage(
    user: AccessTokenPayload,
    conversationId: string,
    body: string,
  ): Promise<Message> {
    if (user.role === 'viewer') throw FORBIDDEN;
    let notifyRecipients: string[] = [];
    const sent = await withTenant(
      user.orgId,
      async (tx) => {
        // RLS hides a non-participant thread → 404 (no oracle). The messages
        // WITH CHECK also enforces participant-only insert at the DB level.
        const [conv] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        if (!conv) throw NOT_FOUND;

        const [row] = await tx
          .insert(messages)
          .values({
            orgId: user.orgId,
            conversationId,
            senderId: user.sub,
            body,
          })
          .returning();
        if (!row) {
          throw new InternalServerErrorException({
            error: { code: 'insert_no_row', message: 'unexpected db state' },
          });
        }

        // Bump the thread recency key + mark the SENDER caught up — derived from
        // the message's OWN db clock (row.createdAt), not a separate JS `now`, so
        // the recency key and read-watermark can never skew against the message
        // they describe (a concurrent insert can't land in the gap).
        await tx
          .update(conversations)
          .set({ lastMessageAt: row.createdAt, updatedAt: row.createdAt })
          .where(eq(conversations.id, conversationId));
        await tx
          .update(conversationParticipants)
          .set({ lastReadAt: row.createdAt })
          .where(
            and(
              eq(conversationParticipants.conversationId, conversationId),
              eq(conversationParticipants.userId, user.sub),
            ),
          );

        // Audit the content-authoring write (parity with note.create). IDs only —
        // the message body is member-internal and never copied into the audit.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'message.send',
          targetTable: 'messages',
          targetId: row.id,
          sessionId: user.sid,
        });

        // Resolve the OTHER participants (inside the tx) for the after-commit
        // message_received fan-out.
        const recipients = await tx
          .select({ userId: conversationParticipants.userId })
          .from(conversationParticipants)
          .where(
            and(
              eq(conversationParticipants.conversationId, conversationId),
              ne(conversationParticipants.userId, user.sub),
            ),
          );
        notifyRecipients = recipients.map((r) => r.userId);

        return toMessage(row);
      },
      { userId: user.sub },
    );
    await this.notifyParticipants(user.orgId, conversationId, notifyRecipients);
    return sent;
  }

  async markRead(user: AccessTokenPayload, conversationId: string): Promise<void> {
    await withTenant(
      user.orgId,
      async (tx) => {
        const [conv] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        if (!conv) throw NOT_FOUND;
        await tx
          .update(conversationParticipants)
          .set({ lastReadAt: new Date() })
          .where(
            and(
              eq(conversationParticipants.conversationId, conversationId),
              eq(conversationParticipants.userId, user.sub),
            ),
          );
      },
      { userId: user.sub },
    );
  }
}
