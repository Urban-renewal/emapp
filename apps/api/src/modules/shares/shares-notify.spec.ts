/**
 * P5.S4 — share_revoked notification fan-out (real-DB, adversarial).
 *
 * SharesService.revoke(user, id) emits, best-effort AFTER commit, a
 * `share_revoked` notification whose recipients are resolved through the ONE
 * central helper `resolveNotificationRecipients` (D-O7 default). For a revoke
 * the producer passes ONLY { projectId, actorUserId } (no relevantUserIds), so:
 *
 *   recipients = (ALL active org MANAGERS)              ← managers ALWAYS notified
 *              ∪ (active project-assigned AGENTS)        ← the share's project
 *              − the REVOKER (user.sub, the actor)       ← self-exclusion (managers too)
 *
 * body = `הרשאת <contractor.name> בוטלה.` — the contractor's COMPANY/business
 * name ONLY. contactEmail / contactPhone are PERSONAL data and MUST NEVER reach
 * the notification (title/body/metadata). metadata = { shareId, projectId }.
 *
 * Idempotent re-revoke (already revokedAt) → early return, NO emit.
 *
 * Ground truth: the `notifications` table is read via providerPool (BYPASSRLS).
 *
 * Adversarial / load-bearing items:
 *  1) revoke → project agents + OTHER managers notified; revoker excluded;
 *     metadata carries { shareId, projectId }.
 *  2) already-revoked re-revoke → ZERO new share_revoked rows (gated on the
 *     revokedAt transition — would FAIL if the emit weren't early-returned).
 *  3) PII guard — contractor seeded with a recognizable contactEmail +
 *     contactPhone; neither (nor any national-id-shaped value) appears in ANY
 *     share_revoked title/body/metadata; only the company `name` may appear.
 *     metadata keys are EXACTLY { shareId, projectId }.
 *  4) actor-exclusion + dedup — a revoker who is ALSO a project assignee is
 *     excluded; a recipient who double-qualifies (manager AND assignee) appears
 *     once.
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  db,
  defaultSharePermissions,
  memberships,
  projectAssignments,
  projects,
  shares as sharesTable,
  users,
  withTenant,
} from '@emapp/db';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { ShareTokenService } from '../contractor-portal/share-token.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { SharesService } from './shares.service';

let svc: SharesService;
let org: TestOrg;

/** The createTestOrg-seeded manager (the PRIMARY manager). */
let managerPrimary: string;
/** A SECOND active manager — never the actor here, so always a recipient. */
let managerSecond: string;
/** projects[0] — the share lives here; agentA + agentB are assigned. */
let projectId: string;

let agentA: string;
let agentB: string;
/** Assigned to projectId then unassigned — must be excluded. */
let agentStale: string;

const SID = '00000000-0000-4000-8000-0000000000a4';

// Recognizable PII the test asserts NEVER leaks into a notification. The org has
// a UNIQUE(org_id, contact_email) constraint on active contractors, so each
// seeded contractor needs a distinct email — we mint a recognizable per-seed
// secret and assert against THOSE exact values (not a shared constant).
const COMPANY_NAME = 'אקמה בנייה בע"מ'; // business/company label — MAY appear in body

interface SeededContractor {
  id: string;
  email: string; // recognizable secret PERSONAL email — must NEVER leak
  phone: string; // recognizable secret PERSONAL phone — must NEVER leak
}

function payload(sub: string, role: 'manager' | 'agent'): AccessTokenPayload {
  return { sub, orgId: org.id, role, sid: SID, type: 'access' } as unknown as AccessTokenPayload;
}

async function seedUser(role: 'manager' | 'agent', orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${role}-${randomUUID()}@test.local`,
      name: role === 'manager' ? 'Manager' : 'Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db.insert(memberships).values({
    userId: u!.id,
    orgId,
    role,
    acceptedAt: new Date(),
    ...(role === 'agent'
      ? {
          capabilities: {
            edit_project_data: false,
            manage_documents: false,
            manage_signatures: false,
            manage_tasks: false,
            run_imports: false,
            view_owners: true,
            view_owner_pii: false,
          },
        }
      : {}),
  });
  return u!.id;
}

async function assign(
  projectId: string,
  userId: string,
  opts: { unassigned?: boolean } = {},
): Promise<void> {
  await db.insert(projectAssignments).values({
    projectId,
    userId,
    assignedBy: managerPrimary,
    ...(opts.unassigned ? { unassignedAt: new Date() } : {}),
  });
}

/**
 * Seed a contractor carrying recognizable PII (contactEmail + contactPhone) and
 * a company name. Returns the id. providerPool (BYPASSRLS) so we control the row
 * exactly; org_id pins it to the test org.
 */
async function seedContractorWithPii(orgId: string): Promise<SeededContractor> {
  // Distinct, recognizable per-seed PII (avoids the org_email_active unique
  // collision while staying easy to grep for in the leak assertions). The phone
  // is a full IL mobile, the email a unique-but-obviously-secret address.
  const nonce = randomUUID().slice(0, 8);
  const email = `contractor-secret-${nonce}@x.com`;
  // A clean, well-formed IL mobile (05X + 7 digits) — derived from the nonce so
  // it is distinct per seed AND would be caught by the /05\d-?\d{7}/ leak guard
  // if it ever reached a notification.
  const phoneDigits = (parseInt(nonce, 16) % 10_000_000).toString().padStart(7, '0');
  const phone = `050${phoneDigits}`;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO contractors (org_id, name, contact_email, contact_phone, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, COMPANY_NAME, email, phone, managerPrimary],
    );
    return { id: r.rows[0]!.id, email, phone };
  } finally {
    c.release();
  }
}

/** Create an ACTIVE share on a project for a contractor (manager-side path). */
async function createShare(contractorId: string, onProjectId: string): Promise<string> {
  const share = await svc.create(payload(managerPrimary, 'manager'), onProjectId, {
    contractorId,
    permissions: defaultSharePermissions(),
  });
  return share.id;
}

/** All notification rows for a recipient, newest first (ground truth, BYPASSRLS). */
async function notifsFor(
  userId: string,
): Promise<
  Array<{ type: string; title: string; body: string | null; metadata: Record<string, unknown> }>
> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      type: string;
      title: string;
      body: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT type, title, body, metadata FROM notifications
       WHERE user_id = $1 AND org_id = $2 ORDER BY created_at DESC`,
      [userId, org.id],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

/** share_revoked rows for a recipient whose metadata.shareId matches `shareId`. */
async function revokedNotifsForShare(
  userId: string,
  shareId: string,
): Promise<
  Array<{ type: string; title: string; body: string | null; metadata: Record<string, unknown> }>
> {
  const all = await notifsFor(userId);
  return all.filter((n) => n.type === 'share_revoked' && n.metadata?.['shareId'] === shareId);
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SharesService(
    new ShareTokenService(new JwtService({ secret: serverEnv.JWT_SECRET })),
    new NotificationsProducerService(),
  );
  const tag = `p5s4-revoke-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerPrimary = org.users[0]!.id;
  projectId = org.projects[0]!.id;

  managerSecond = await seedUser('manager', org.id);
  agentA = await seedUser('agent', org.id);
  agentB = await seedUser('agent', org.id);
  agentStale = await seedUser('agent', org.id);

  await assign(projectId, agentA);
  await assign(projectId, agentB);
  await assign(projectId, agentStale, { unassigned: true });
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('P5.S4 — share_revoked notification fan-out', () => {
  it('1) revoke notifies project agents + the OTHER manager(s); the revoking actor does NOT; metadata = { shareId, projectId }', async () => {
    const contractor = await seedContractorWithPii(org.id);
    const shareId = await createShare(contractor.id, projectId);

    // managerPrimary revokes → recipients = managers ∪ assigned agents − actor.
    await svc.revoke(payload(managerPrimary, 'manager'), shareId);

    // Assigned agents A + B → exactly one share_revoked for THIS share.
    for (const agent of [agentA, agentB]) {
      // eslint-disable-next-line no-await-in-loop
      const hit = await revokedNotifsForShare(agent, shareId);
      expect(hit).toHaveLength(1);
      expect(hit[0]!.type).toBe('share_revoked');
      expect(hit[0]!.title).toBe('גישת קבלן בוטלה');
      // metadata carries BOTH ids, with the right values.
      expect(hit[0]!.metadata['shareId']).toBe(shareId);
      expect(hit[0]!.metadata['projectId']).toBe(projectId);
    }

    // The OTHER (non-actor) manager IS notified (managers-always, D-O7).
    const second = await revokedNotifsForShare(managerSecond, shareId);
    expect(second).toHaveLength(1);
    expect(second[0]!.metadata['shareId']).toBe(shareId);
    expect(second[0]!.metadata['projectId']).toBe(projectId);

    // The REVOKER (managerPrimary, the actor) is excluded → zero for this share.
    expect(await revokedNotifsForShare(managerPrimary, shareId)).toHaveLength(0);

    // The unassigned (stale) agent is excluded.
    expect(await revokedNotifsForShare(agentStale, shareId)).toHaveLength(0);
  }, 30_000);

  it('2) already-revoked re-revoke → ZERO new share_revoked rows (gated on the revokedAt transition)', async () => {
    const contractor = await seedContractorWithPii(org.id);
    const shareId = await createShare(contractor.id, projectId);

    // First revoke (by the SECOND manager → primary + agents are recipients).
    await svc.revoke(payload(managerSecond, 'manager'), shareId);

    // Baseline counts across every candidate recipient AFTER the first revoke.
    const recipients = [managerPrimary, managerSecond, agentA, agentB, agentStale];
    const before = new Map<string, number>();
    for (const u of recipients) {
      // eslint-disable-next-line no-await-in-loop
      before.set(u, (await revokedNotifsForShare(u, shareId)).length);
    }

    // Re-revoke the SAME (already-revoked) share — idempotent no-op, NO emit.
    await svc.revoke(payload(managerSecond, 'manager'), shareId);
    // And once more from a DIFFERENT manager to be thorough.
    await svc.revoke(payload(managerPrimary, 'manager'), shareId);

    // ZERO new share_revoked rows anywhere for this share.
    for (const u of recipients) {
      // eslint-disable-next-line no-await-in-loop
      const after = (await revokedNotifsForShare(u, shareId)).length;
      expect(after).toBe(before.get(u));
    }
  }, 30_000);

  it('3) PII guard: contactEmail + contactPhone NEVER appear in any share_revoked title/body/metadata; only the company name may; metadata keys are exactly { shareId, projectId }', async () => {
    const contractor = await seedContractorWithPii(org.id);
    const shareId = await createShare(contractor.id, projectId);

    // Sanity: the seeded contractor really does carry the secret PII (so the
    // guard below is non-vacuous — there IS something that COULD leak).
    {
      const c = await providerPool.connect();
      try {
        const r = await c.query<{ contact_email: string; contact_phone: string; name: string }>(
          `SELECT contact_email, contact_phone, name FROM contractors WHERE id = $1`,
          [contractor.id],
        );
        expect(r.rows[0]!.contact_email).toBe(contractor.email);
        expect(r.rows[0]!.contact_phone).toBe(contractor.phone);
        expect(r.rows[0]!.name).toBe(COMPANY_NAME);
      } finally {
        c.release();
      }
    }

    await svc.revoke(payload(managerPrimary, 'manager'), shareId);

    // Inspect EVERY share_revoked notification produced for this share across
    // every recipient (agents + the second manager).
    const all: Array<{
      type: string;
      title: string;
      body: string | null;
      metadata: Record<string, unknown>;
    }> = [];
    for (const u of [agentA, agentB, managerSecond]) {
      // eslint-disable-next-line no-await-in-loop
      all.push(...(await revokedNotifsForShare(u, shareId)));
    }
    expect(all.length).toBeGreaterThan(0); // there ARE rows to scrutinize

    for (const n of all) {
      const humanText = `${n.title}\n${n.body ?? ''}`;
      const haystack = `${humanText}\n${JSON.stringify(n.metadata)}`;
      // The personal PII (exact seeded values) must be ABSENT everywhere — incl. metadata.
      expect(haystack).not.toContain(contractor.email);
      expect(haystack).not.toContain(contractor.phone);
      // Generic PII-SHAPE guards (defense in depth) apply to the human-facing
      // title+body — the text where a national_id / phone / email would actually be a
      // leak. They are deliberately NOT run over JSON.stringify(metadata): the metadata
      // is asserted below to be EXACTLY { shareId, projectId } (two known UUIDs) — a
      // STRICTER guarantee than a shape-match, so it cannot carry PII. Running \d{9,}
      // over a UUID was a flaky false-positive (a random 9-digit run inside the hex of
      // shareId/projectId is not PII; it failed nondeterministically per UUID generation).
      expect(humanText).not.toMatch(/\d{9,}/); // no 9+ digit run (national_id / phone)
      expect(humanText).not.toMatch(/05\d-?\d{7}/); // no IL mobile
      expect(humanText).not.toMatch(/[\w.+-]+@[\w.-]+\.\w+/); // no email at all

      // Only the COMPANY name is allowed in the body, and it IS present.
      expect(n.body).toContain(COMPANY_NAME);

      // metadata keys are EXACTLY { shareId, projectId } — no extra fields.
      expect(Object.keys(n.metadata).sort()).toEqual(['projectId', 'shareId']);
      expect(n.metadata['shareId']).toBe(shareId);
      expect(n.metadata['projectId']).toBe(projectId);
    }
  }, 30_000);

  it('4) actor-exclusion + dedup: a revoker who is ALSO a project assignee is excluded; a manager who is ALSO assigned appears once', async () => {
    // Fresh project so the assignment graph is exactly what we set here.
    const dedupProjectId = await withTenant(
      org.id,
      async (tx) => {
        const [p] = await tx
          .insert(projects)
          .values({
            orgId: org.id,
            name: `dedup-${randomUUID()}`,
            type: 'tama38_1',
            createdBy: managerPrimary,
          })
          .returning({ id: projects.id });
        return p!.id;
      },
      { userId: managerPrimary },
    );

    // agentA is the REVOKER and is ALSO assigned to this project → must be
    // excluded as actor even though Rule 1 would otherwise include them.
    // managerSecond is BOTH an always-on manager AND a project assignee →
    // double-qualifies → must appear exactly ONCE.
    await assign(dedupProjectId, agentA);
    await assign(dedupProjectId, managerSecond);

    const contractor = await seedContractorWithPii(org.id);
    const shareId = await createShare(contractor.id, dedupProjectId);

    // agentA (an assigned agent) revokes. requireManager: revoke is manager-only,
    // so the actor must carry role 'manager'; but the EXCLUSION is by user id
    // (user.sub), independent of the claimed role. We therefore drive the revoke
    // with agentA's id under a manager payload to exercise actor-exclusion of a
    // user who is genuinely a project assignee.
    await svc.revoke(payload(agentA, 'manager'), shareId);

    // agentA is the actor → excluded despite being assigned.
    expect(await revokedNotifsForShare(agentA, shareId)).toHaveLength(0);

    // managerSecond double-qualifies (manager + assignee) → exactly ONE row.
    const second = await revokedNotifsForShare(managerSecond, shareId);
    expect(second).toHaveLength(1);
    expect(second[0]!.metadata['shareId']).toBe(shareId);
    expect(second[0]!.metadata['projectId']).toBe(dedupProjectId);

    // managerPrimary is a non-actor manager → also notified exactly once.
    expect(await revokedNotifsForShare(managerPrimary, shareId)).toHaveLength(1);

    // Sanity: the share really is revoked now (transition happened).
    const [row] = await db
      .select({ revokedAt: sharesTable.revokedAt, revokedBy: sharesTable.revokedBy })
      .from(sharesTable)
      .where(and(eq(sharesTable.id, shareId), eq(sharesTable.contractorId, contractor.id)))
      .limit(1);
    expect(row?.revokedAt).toBeTruthy();
    expect(row?.revokedBy).toBe(agentA);
  }, 30_000);
});
