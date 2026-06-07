/**
 * P5.S3 — note_added notification fan-out (real-DB, deterministic, adversarial).
 *
 * NotesService.create(user, input) emits, best-effort AFTER commit, a
 * `note_added` notification whose recipients are resolved through the ONE
 * central helper `resolveNotificationRecipients` (D-O7 default). The recipient
 * set is:
 *
 *   recipients = (ALL active org MANAGERS)               ← managers ALWAYS notified
 *              ∪ (active project-assigned AGENTS)         ← only when a project resolves
 *              − the AUTHOR (user.sub, the actor)         ← self-exclusion (managers too)
 *
 * Project context: note.projectId, else apartmentId → building → project, else
 * org-level (no project context → projectId undefined, agents NOT added, but
 * managers-always still fires).
 *
 * PII (load-bearing): a note's free-text `body` may mention residents, money,
 * national-ids, disputes. It is NEVER placed in the notification — the
 * notification carries only a GENERIC static label; the noteId in metadata lets
 * a recipient open the real note through the normal RLS-scoped read. Test PII-2
 * proves the marker text never reaches ANY notification title/body/metadata.
 *
 * Ground truth: the `notifications` table is read via providerPool (BYPASSRLS).
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  db,
  memberships,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { NotesService } from './notes.service';

let svc: NotesService;
let org: TestOrg;
let managerA: string; // the createTestOrg-seeded manager (actor in some cases)
let managerB: string; // a SECOND manager — so managers-always − actor isn't vacuous
let projectTeam: string; // projects[0] — agentA + agentB assigned (active)
let projectOther: string; // projects[1] — agentC assigned (the "wrong"/decoy project)

let agentA: string; // assigned to projectTeam
let agentB: string; // assigned to projectTeam
let agentC: string; // assigned to projectOther only — never notified for projectTeam
let nonAssignee: string; // an agent assigned to NOTHING — never a project recipient

const SID = '00000000-0000-4000-8000-0000000000a0';

function payload(sub: string, role: 'manager' | 'agent'): AccessTokenPayload {
  return { sub, orgId: org.id, role, sid: SID, type: 'access' } as unknown as AccessTokenPayload;
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `agent-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db.insert(memberships).values({
    userId: u!.id,
    orgId,
    role: 'agent',
    acceptedAt: new Date(),
  });
  return u!.id;
}

async function seedManager(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `manager-${randomUUID()}@test.local`,
      name: 'Manager',
      passwordHash: '$2b$12$x',
    })
    .returning({ id: users.id });
  await db.insert(memberships).values({
    userId: u!.id,
    orgId,
    role: 'manager',
    acceptedAt: new Date(),
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
    assignedBy: managerA,
    ...(opts.unassigned ? { unassignedAt: new Date() } : {}),
  });
}

/** All notification rows for a recipient, newest first (provider/BYPASSRLS read). */
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

/** note_added rows for a recipient whose metadata.noteId matches `noteId`. */
async function noteAddedFor(
  userId: string,
  noteId: string,
): Promise<
  Array<{ type: string; title: string; body: string | null; metadata: Record<string, unknown> }>
> {
  return (await notifsFor(userId)).filter(
    (n) => n.type === 'note_added' && n.metadata?.noteId === noteId,
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new NotesService(new NotificationsProducerService());
  const tag = `notes-notify-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerA = org.users[0]!.id;
  projectTeam = org.projects[0]!.id;
  projectOther = org.projects[1]!.id;

  managerB = await seedManager(org.id);
  agentA = await seedAgent(org.id);
  agentB = await seedAgent(org.id);
  agentC = await seedAgent(org.id);
  nonAssignee = await seedAgent(org.id);

  // projectTeam: A + B active.
  await assign(projectTeam, agentA);
  await assign(projectTeam, agentB);
  // projectOther: C (decoy / wrong-project).
  await assign(projectOther, agentC);
  // nonAssignee: deliberately assigned to nothing.
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('P5.S3 — note_added notification fan-out', () => {
  it('NN-1) an agent (assignee) creates a project note → OTHER project agent + BOTH managers notified; the author (actor) + the non-assignee NOT', async () => {
    // agentA authors. Recipients = managers(A,B) ∪ projectTeam agents(A,B) − actor(agentA).
    //   = {managerA, managerB, agentB}. agentA (author) excluded; agentC (wrong
    //   project) + nonAssignee (no assignment) absent.
    const note = await svc.create(payload(agentA, 'agent'), {
      body: 'a routine project note',
      projectId: projectTeam,
    });
    expect(note.id).toBeTruthy();

    // OTHER assigned agent → exactly one note_added for this note.
    const b = await noteAddedFor(agentB, note.id);
    expect(b).toHaveLength(1);
    expect(b[0]!.title).toBe('הערה חדשה נוספה');
    expect(b[0]!.metadata.noteId).toBe(note.id);

    // BOTH managers (managers-always; neither is the actor) → notified.
    expect(await noteAddedFor(managerA, note.id)).toHaveLength(1);
    expect(await noteAddedFor(managerB, note.id)).toHaveLength(1);

    // AUTHOR (actor) → NOT notified of their own note.
    expect(await noteAddedFor(agentA, note.id)).toHaveLength(0);

    // Non-assignee + wrong-project agent → NOT notified.
    expect(await noteAddedFor(nonAssignee, note.id)).toHaveLength(0);
    expect(await noteAddedFor(agentC, note.id)).toHaveLength(0);
  }, 30_000);

  it('NN-2) PII GUARD (load-bearing): the note free-text marker NEVER appears in any notification title/body/metadata', async () => {
    // The note body carries a sensitive marker (a fake national-id-looking value
    // + a Hebrew "secret" string). If the builder ever templated the note text
    // into the notification body, THIS test fails. The notification must carry
    // only the generic static label + noteId.
    const MARKER_ID = '123456789'; // 9-digit national-id-looking value
    const MARKER_HE = 'סודי-12345';
    const sensitiveBody = `הדייר ${MARKER_HE} ת.ז. ${MARKER_ID} מסרב לחתום, חוב 250000 ש"ח`;

    // managerA authors so the recipients are {managerB, agentA, agentB} (non-empty,
    // exercises the real emit path on a project note).
    const note = await svc.create(payload(managerA, 'manager'), {
      body: sensitiveBody,
      projectId: projectTeam,
    });
    expect(note.id).toBeTruthy();
    // The note row itself DID persist the body (sanity: the marker is real).
    expect(note.body).toContain(MARKER_ID);
    expect(note.body).toContain(MARKER_HE);

    // Sweep EVERY recipient who actually got a row for this note.
    const recipients = [managerB, agentA, agentB];
    let sawAtLeastOneRow = false;
    for (const uid of recipients) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await noteAddedFor(uid, note.id);
      expect(rows).toHaveLength(1); // each got exactly one
      sawAtLeastOneRow = true;
      const row = rows[0]!;
      const haystack = `${row.title} ${row.body ?? ''} ${JSON.stringify(row.metadata)}`;
      // The marker text MUST NOT appear anywhere in the notification.
      expect(haystack).not.toContain(MARKER_ID);
      expect(haystack).not.toContain(MARKER_HE);
      expect(haystack).not.toContain('250000');
      // 9-digit national-id pattern must not appear in title/body.
      expect(`${row.title} ${row.body ?? ''}`).not.toMatch(/\d{9}/);
      // metadata is exactly { noteId }, nothing leaked from the body.
      expect(Object.keys(row.metadata).sort()).toEqual(['noteId']);
      expect(row.metadata.noteId).toBe(note.id);
    }
    // Guard is NON-VACUOUS: at least one notification row was actually inspected.
    expect(sawAtLeastOneRow).toBe(true);
  }, 30_000);

  it('NN-3) org-level note (no project / no apartment) → managers-always notified; NO project agents', async () => {
    // agentA authors an org-level note (no projectId, no apartmentId). Recipients
    // = managers(A,B) − actor. agentA is the actor and is NOT a manager, so the
    // set is {managerA, managerB}. No project ⇒ NO project agents are added.
    const note = await svc.create(payload(agentA, 'agent'), {
      body: 'an org-level note with no project context',
    });
    expect(note.id).toBeTruthy();
    expect(note.projectId).toBeNull();
    expect(note.apartmentId).toBeNull();

    // BOTH managers still notified (managers-always is unconditional).
    expect(await noteAddedFor(managerA, note.id)).toHaveLength(1);
    expect(await noteAddedFor(managerB, note.id)).toHaveLength(1);

    // No project ⇒ project agents NOT added. agentB (a projectTeam agent) and
    // agentC must get NOTHING for this org-level note; author excluded.
    expect(await noteAddedFor(agentA, note.id)).toHaveLength(0);
    expect(await noteAddedFor(agentB, note.id)).toHaveLength(0);
    expect(await noteAddedFor(agentC, note.id)).toHaveLength(0);
    expect(await noteAddedFor(nonAssignee, note.id)).toHaveLength(0);
  }, 30_000);

  it('NN-4) apartment-level note (no projectId) → resolves apartment→building→project; THAT project team notified', async () => {
    // A note attached to an apartment (no explicit projectId) must resolve the
    // project via apartment → building → project and notify THAT project's team.
    // We host the apartment under projectOther (agentC's project) to prove the
    // resolution targets the right team, not projectTeam's.
    const { apartmentId } = await withTenant(
      org.id,
      async (tx) => {
        const [bld] = await tx
          .insert(buildings)
          .values({ projectId: projectOther, address: 'Herzl 1', city: 'TLV' })
          .returning({ id: buildings.id });
        const [apt] = await tx
          .insert(apartments)
          .values({ buildingId: bld!.id, number: `${Math.floor(Math.random() * 1000000)}` })
          .returning({ id: apartments.id });
        return { apartmentId: apt!.id };
      },
      { userId: managerA },
    );

    // managerA authors → recipients = managers(A,B) ∪ projectOther agents(C) − actor(managerA)
    //   = {managerB, agentC}.
    const note = await svc.create(payload(managerA, 'manager'), {
      body: 'note on an apartment',
      apartmentId,
    });
    expect(note.id).toBeTruthy();
    expect(note.apartmentId).toBe(apartmentId);
    expect(note.projectId).toBeNull();

    // agentC (the apartment's project team) → notified.
    expect(await noteAddedFor(agentC, note.id)).toHaveLength(1);
    // managerB → notified (managers-always, not the actor).
    expect(await noteAddedFor(managerB, note.id)).toHaveLength(1);
    // managerA (actor) → NOT notified.
    expect(await noteAddedFor(managerA, note.id)).toHaveLength(0);
    // projectTeam agents are on a DIFFERENT project → NOT notified.
    expect(await noteAddedFor(agentA, note.id)).toHaveLength(0);
    expect(await noteAddedFor(agentB, note.id)).toHaveLength(0);
  }, 30_000);

  it('NN-5) actor-exclusion + dedup: a manager who is ALSO a project assignee appears at most once and never to themselves', async () => {
    // managerB is assigned to projectTeam (so they qualify BOTH via managers-always
    // AND via project-assignee). When managerB authors a note on projectTeam,
    // they must be excluded (actor) AND, for the OTHER recipients who qualify via
    // two rules, the row appears exactly ONCE (dedup).
    await assign(projectTeam, managerB); // managerB now both a manager AND a projectTeam assignee

    const note = await svc.create(payload(managerB, 'manager'), {
      body: 'note authored by a manager who is also assigned',
      projectId: projectTeam,
    });
    expect(note.id).toBeTruthy();

    // managerB is the actor AND an assignee AND a manager → excluded → zero rows.
    expect(await noteAddedFor(managerB, note.id)).toHaveLength(0);

    // managerA qualifies via managers-always only → exactly one row (no dup).
    expect(await noteAddedFor(managerA, note.id)).toHaveLength(1);
    // agentA + agentB qualify via project-assignee → exactly one each.
    expect(await noteAddedFor(agentA, note.id)).toHaveLength(1);
    expect(await noteAddedFor(agentB, note.id)).toHaveLength(1);
  }, 30_000);
});
