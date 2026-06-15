/**
 * TEAM MESSAGING — Slice 1 acceptance tests (real-DB, in-process service).
 *
 * Asserts the participation-based authorization model (NOT the IAM matrix):
 *   - happy path: create thread + first message, send, list, unread counts,
 *     mark-read;
 *   - PARTICIPANT isolation: a member who is NOT a participant cannot see the
 *     thread or its messages (service → no-oracle 404; RLS → zero rows), and
 *     cannot post into it;
 *   - CROSS-ORG isolation: another org never sees the thread;
 *   - VIEWER is read-only: may read a thread it participates in but may NOT
 *     create a thread or send a message (403);
 *   - participant validation: a non-member / foreign-org id is rejected (400);
 *   - schema/RLS/journal pins for migration 0075.
 *
 * Harness mirrors parcel-setups.spec.ts: createTestOrg + mock AccessTokenPayload
 * + the service exercised directly; raw seeding / RLS probes via providerPool
 * (BYPASSRLS).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { db, memberships, users } from '@emapp/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { MessagingService } from './messaging.service';

const JOURNAL_MAX_WHEN_BEFORE_MESSAGING = 1_783_090_800_000; // 0074_parcel_lookup

let org: TestOrg;
let otherOrg: TestOrg;
let managerId: string;
let agentAId: string; // a participant in the test thread
let agentBId: string; // a member who is NOT a participant
let viewerId: string; // a viewer (read-only) participant
let otherOrgUserId: string;

const svc = new MessagingService();

function actor(
  userId: string,
  orgId: string,
  role: 'manager' | 'agent' | 'viewer',
): AccessTokenPayload {
  return {
    sub: userId,
    orgId,
    role,
    sid: '00000000-0000-4000-8000-0000000000a1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedMember(orgId: string, role: 'manager' | 'agent' | 'viewer'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `msg-${role}-${randomUUID()}@test.local`,
      name: `Msg ${role}`,
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db.insert(memberships).values({ userId: u!.id, orgId, role, acceptedAt: new Date() });
  return u!.id;
}

function httpStatus(e: unknown): number | null {
  if (e && typeof e === 'object') {
    const maybe = e as { getStatus?: () => number; status?: number };
    if (typeof maybe.getStatus === 'function') return maybe.getStatus();
    if (typeof maybe.status === 'number') return maybe.status;
  }
  return null;
}

async function rlsVisibleCount(
  table: 'conversations' | 'messages',
  where: string,
  params: unknown[],
  asUserId: string,
  orgId: string,
): Promise<number> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query({
      text: 'SELECT set_config($1,$2,true)',
      values: ['app.organization_id', orgId],
    });
    await c.query({ text: 'SELECT set_config($1,$2,true)', values: ['app.user_id', asUserId] });
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(r.rows[0]!.n);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `msg-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  otherOrg = await createTestOrg(`${tag}-b`, `${tag}-b`);
  managerId = org.users[0]!.id;
  agentAId = await seedMember(org.id, 'agent');
  agentBId = await seedMember(org.id, 'agent');
  viewerId = await seedMember(org.id, 'viewer');
  otherOrgUserId = otherOrg.users[0]!.id;
}, 120_000);

// ───────────────────────────────────────────────────────────────────────────
// A) happy path — create thread + first message, send, list, unread, read
// ───────────────────────────────────────────────────────────────────────────
describe('messaging · happy path', () => {
  it('A1) manager creates a thread with a first message → enriched shape (participants, lastMessage, own unread 0)', async () => {
    const conv = await svc.create(actor(managerId, org.id, 'manager'), {
      participantIds: [agentAId],
      body: 'שלום, נתחיל לעבוד על הפרויקט',
    });
    expect(conv.participantIds.sort()).toEqual([managerId, agentAId].sort());
    expect(conv.createdBy).toBe(managerId);
    expect(conv.lastMessage?.body).toBe('שלום, נתחיל לעבוד על הפרויקט');
    expect(conv.lastMessage?.senderId).toBe(managerId);
    // The creator authored the only message → nothing unread for them.
    expect(conv.unreadCount).toBe(0);
  }, 30_000);

  it('A2) the OTHER participant sees the thread with unread=1; after they send, the manager has unread=1; mark-read clears it', async () => {
    const created = await svc.create(actor(managerId, org.id, 'manager'), {
      participantIds: [agentAId],
      body: 'הודעה ראשונה',
    });

    // Agent A: the manager's message is unread.
    const agentList = await svc.list(actor(agentAId, org.id, 'agent'), { limit: 25 });
    const seenByAgent = agentList.data.find((c) => c.id === created.id);
    expect(seenByAgent, 'agent A participates → sees the thread').toBeTruthy();
    expect(seenByAgent!.unreadCount).toBe(1);

    // Agent A replies.
    const reply = await svc.sendMessage(actor(agentAId, org.id, 'agent'), created.id, 'קיבלתי');
    expect(reply.senderId).toBe(agentAId);
    expect(reply.body).toBe('קיבלתי');

    // Manager now has 1 unread (the agent's reply); reply moved the thread up.
    const mgrList = await svc.list(actor(managerId, org.id, 'manager'), { limit: 25 });
    const seenByMgr = mgrList.data.find((c) => c.id === created.id);
    expect(seenByMgr!.unreadCount).toBe(1);
    expect(seenByMgr!.lastMessage?.body).toBe('קיבלתי');

    // Manager reads → unread clears.
    await svc.markRead(actor(managerId, org.id, 'manager'), created.id);
    const mgrList2 = await svc.list(actor(managerId, org.id, 'manager'), { limit: 25 });
    expect(mgrList2.data.find((c) => c.id === created.id)!.unreadCount).toBe(0);
  }, 30_000);

  it('A3) listMessages returns the thread messages newest-first, keyset-paginated', async () => {
    const created = await svc.create(actor(managerId, org.id, 'manager'), {
      participantIds: [agentAId],
      body: 'm1',
    });
    await svc.sendMessage(actor(managerId, org.id, 'manager'), created.id, 'm2');
    await svc.sendMessage(actor(agentAId, org.id, 'agent'), created.id, 'm3');

    const page = await svc.listMessages(actor(managerId, org.id, 'manager'), created.id, {
      limit: 50,
    });
    const bodies = page.data.map((m) => m.body);
    expect(bodies).toContain('m1');
    expect(bodies).toContain('m2');
    expect(bodies).toContain('m3');
    // newest-first
    expect(bodies[0]).toBe('m3');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// B) participant isolation (service no-oracle 404 + RLS zero rows)
// ───────────────────────────────────────────────────────────────────────────
describe('messaging · participant isolation', () => {
  it('B1) a NON-participant org member cannot see / read / post into the thread (404), and RLS shows them zero rows', async () => {
    const created = await svc.create(actor(managerId, org.id, 'manager'), {
      participantIds: [agentAId],
      body: 'private thread',
    });

    // Service: agent B (member, NOT a participant) is blind to it.
    const list = await svc.list(actor(agentBId, org.id, 'agent'), { limit: 25 });
    expect(list.data.some((c) => c.id === created.id)).toBe(false);

    const getErr = await svc.get(actor(agentBId, org.id, 'agent'), created.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(httpStatus(getErr)).toBe(404);

    const msgErr = await svc
      .listMessages(actor(agentBId, org.id, 'agent'), created.id, { limit: 50 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(httpStatus(msgErr)).toBe(404);

    const sendErr = await svc
      .sendMessage(actor(agentBId, org.id, 'agent'), created.id, 'let me in')
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(httpStatus(sendErr)).toBe(404);

    // RLS: the non-participant GUC sees zero; a participant sees the rows.
    expect(await rlsVisibleCount('conversations', 'id = $1', [created.id], agentBId, org.id)).toBe(
      0,
    );
    expect(
      await rlsVisibleCount('messages', 'conversation_id = $1', [created.id], agentBId, org.id),
    ).toBe(0);
    expect(await rlsVisibleCount('conversations', 'id = $1', [created.id], managerId, org.id)).toBe(
      1,
    );
    expect(
      await rlsVisibleCount('messages', 'conversation_id = $1', [created.id], managerId, org.id),
    ).toBeGreaterThan(0);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C) cross-org isolation
// ───────────────────────────────────────────────────────────────────────────
describe('messaging · cross-org isolation', () => {
  it('C1) another org never sees the thread (no-oracle 404; not in its list)', async () => {
    const created = await svc.create(actor(managerId, org.id, 'manager'), {
      participantIds: [agentAId],
      body: 'org A only',
    });

    const otherList = await svc.list(actor(otherOrgUserId, otherOrg.id, 'manager'), { limit: 25 });
    expect(otherList.data.some((c) => c.id === created.id)).toBe(false);

    const err = await svc.get(actor(otherOrgUserId, otherOrg.id, 'manager'), created.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(httpStatus(err)).toBe(404);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// D) viewer is read-only
// ───────────────────────────────────────────────────────────────────────────
describe('messaging · viewer read-only', () => {
  it('D1) a viewer participant can READ but cannot CREATE or SEND (403)', async () => {
    // Manager starts a thread that includes the viewer.
    const created = await svc.create(actor(managerId, org.id, 'manager'), {
      participantIds: [viewerId],
      body: 'fyi',
    });

    // Viewer can read (participant).
    const list = await svc.list(actor(viewerId, org.id, 'viewer'), { limit: 25 });
    expect(list.data.some((c) => c.id === created.id)).toBe(true);
    const msgs = await svc.listMessages(actor(viewerId, org.id, 'viewer'), created.id, {
      limit: 50,
    });
    expect(msgs.data.some((m) => m.body === 'fyi')).toBe(true);

    // Viewer cannot send.
    const sendErr = await svc
      .sendMessage(actor(viewerId, org.id, 'viewer'), created.id, 'nope')
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(httpStatus(sendErr)).toBe(403);

    // Viewer cannot create a thread.
    const createErr = await svc
      .create(actor(viewerId, org.id, 'viewer'), { participantIds: [managerId], body: 'nope' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(httpStatus(createErr)).toBe(403);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// E) participant validation
// ───────────────────────────────────────────────────────────────────────────
describe('messaging · participant validation', () => {
  it('E1) a non-member id and a foreign-org member id are both rejected (400 invalid_participant)', async () => {
    const ghostErr = await svc
      .create(actor(managerId, org.id, 'manager'), { participantIds: [randomUUID()] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(httpStatus(ghostErr)).toBe(400);

    const foreignErr = await svc
      .create(actor(managerId, org.id, 'manager'), { participantIds: [otherOrgUserId] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(httpStatus(foreignErr)).toBe(400);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// F) schema + RLS + migration-journal pins
// ───────────────────────────────────────────────────────────────────────────
describe('messaging · schema + RLS + journal pins', () => {
  it('F1) RLS is ENABLED + FORCED on all three messaging tables', async () => {
    const c = await providerPool.connect();
    try {
      for (const t of ['conversations', 'conversation_participants', 'messages']) {
        const cat = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
          [`public.${t}`],
        );
        expect(cat.rows[0]!.relrowsecurity, `${t} RLS enabled`).toBe(true);
        expect(cat.rows[0]!.relforcerowsecurity, `${t} RLS forced`).toBe(true);
      }
    } finally {
      c.release();
    }
  }, 30_000);

  it(`F2) migration journal: a team_messaging entry exists with \`when\` > ${JOURNAL_MAX_WHEN_BEFORE_MESSAGING} and greater than every prior entry (M-1 silent-skip guard)`, () => {
    const journalUrl = new URL(
      '../../../../../packages/db/migrations/meta/_journal.json',
      import.meta.url,
    );
    const journal = z
      .object({
        entries: z.array(z.object({ idx: z.number(), when: z.number(), tag: z.string() })),
      })
      .parse(JSON.parse(readFileSync(journalUrl, 'utf8')));
    const entry = journal.entries.find((e) => /messag/i.test(e.tag));
    expect(entry, '[RED] no team_messaging journal entry').toBeTruthy();
    expect(entry!.when).toBeGreaterThan(JOURNAL_MAX_WHEN_BEFORE_MESSAGING);
    for (const other of journal.entries) {
      if (other === entry || other.idx > entry!.idx) continue;
      expect(entry!.when).toBeGreaterThan(other.when);
    }
  });
});
