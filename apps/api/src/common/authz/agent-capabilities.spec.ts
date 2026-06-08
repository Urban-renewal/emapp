/**
 * D.46 — Agent capability matrix enforcement (canary: edit_project_data on
 * buildings + apartments). Deterministic real-DB integration.
 *
 * Mechanism evidence (D.51 — a plaster can't pass):
 *   - An ASSIGNED agent WITHOUT edit_project_data is blocked (403) on
 *     building/apartment writes — the assignment passes, the CAPABILITY gate
 *     fails (proves the fine gate, not just scoping).
 *   - A manager TOGGLE (via MembersService.updateCapabilities) flips the SAME
 *     agent from blocked → allowed on the SAME action.
 *   - An agent WITH the capability but on an UNASSIGNED project → 404 (the
 *     assignment gate still holds — loosening POLICY didn't open a side door).
 *   - Manager always writes (capability no-op).
 *   - The toggle endpoint rejects non-agents (400 capabilities_agent_only).
 *   - A fresh agent's stored capabilities == the shared-types default (drift
 *     pin between the DB column default and DEFAULT_AGENT_CAPABILITIES).
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import { db, memberships, projectAssignments, users } from '@emapp/db';
import { DEFAULT_AGENT_CAPABILITIES } from '@emapp/shared-types';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { ApartmentsService } from '../../modules/apartments/apartments.service';
import type { AccessTokenPayload } from '../../modules/auth/auth.service';
import { BuildingsService } from '../../modules/buildings/buildings.service';
import { MembersService } from '../../modules/members/members.service';
import { NotificationsProducerService } from '../../modules/notifications/notifications-producer.service';

let buildingsSvc: BuildingsService;
let apartmentsSvc: ApartmentsService;
let membersSvc: MembersService;
let org: TestOrg;
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;

const MGR_SID = '00000000-0000-4000-8000-000000000001';
const AGENT_SID = '00000000-0000-4000-8000-000000000002';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agent(): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `agent-${randomUUID()}@test.local`,
      name: 'Test Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db.insert(memberships).values({
    userId: u!.id,
    orgId,
    role: 'agent',
    acceptedAt: new Date(),
  });
  return u!.id;
}

async function assign(projectId: string, userId: string): Promise<void> {
  await db.insert(projectAssignments).values({ projectId, userId, assignedBy: managerId });
}

async function storedCapabilities(userId: string): Promise<Record<string, boolean>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ capabilities: Record<string, boolean> }>(
      `SELECT capabilities FROM memberships WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL`,
      [userId, org.id],
    );
    return r.rows[0]!.capabilities;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  buildingsSvc = new BuildingsService();
  apartmentsSvc = new ApartmentsService(new NotificationsProducerService());
  membersSvc = new MembersService(new JwtService({ secret: serverEnv.JWT_SECRET }), {} as never);
  const tag = `d46-cap-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  assignedProjectId = org.projects[0]!.id;
  unassignedProjectId = org.projects[1]!.id;
  agentId = await seedAgent(org.id);
  await assign(assignedProjectId, agentId);
}, 90_000);

afterAll(() => {
  /* pools are shared singletons; global teardown closes them */
});

describe('D.46 — agent capability enforcement (buildings + apartments)', () => {
  const bld = (suffix: string) => ({ address: `St ${suffix}`, city: 'TLV' });

  it('D46-DRIFT) a fresh agent membership stores exactly the shared-types default', async () => {
    expect(await storedCapabilities(agentId)).toEqual(DEFAULT_AGENT_CAPABILITIES);
  });

  it('D46-CAP-1) assigned agent WITHOUT edit_project_data → 403 on building create', async () => {
    await expect(buildingsSvc.create(agent(), assignedProjectId, bld('1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('D46-CAP-2) manager always writes (capability no-op)', async () => {
    const b = await buildingsSvc.create(manager(), assignedProjectId, bld('mgr'));
    expect(b.id).toBeTruthy();
  });

  it('D46-CAP-3) manager toggle ON flips the SAME agent from blocked → allowed', async () => {
    const updated = await membersSvc.updateCapabilities(manager(), agentId, {
      edit_project_data: true,
    });
    expect(updated.capabilities?.edit_project_data).toBe(true);
    // view_owners (untouched) still at its default true — merge, not replace.
    expect(updated.capabilities?.view_owners).toBe(true);

    const b = await buildingsSvc.create(agent(), assignedProjectId, bld('2'));
    expect(b.id).toBeTruthy();
    // update + archive of that building also succeed now.
    const upd = await buildingsSvc.update(agent(), b.id, { city: 'Haifa' });
    expect(upd.city).toBe('Haifa');
    await expect(buildingsSvc.archive(agent(), b.id)).resolves.toBeUndefined();
  }, 30_000);

  it('D46-CAP-4) agent WITH capability but UNASSIGNED project → 404 (assignment gate holds)', async () => {
    // edit_project_data is ON from CAP-3; the side-door is the assignment check.
    await expect(
      buildingsSvc.create(agent(), unassignedProjectId, bld('x')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('D46-CAP-5) manager toggle OFF re-blocks the agent', async () => {
    await membersSvc.updateCapabilities(manager(), agentId, { edit_project_data: false });
    await expect(buildingsSvc.create(agent(), assignedProjectId, bld('3'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('D46-CAP-6) apartments honour the same capability', async () => {
    // Manager creates a building in the assigned project to host apartments.
    const b = await buildingsSvc.create(manager(), assignedProjectId, bld('apt-host'));
    const apt = { number: '4' };
    // agent OFF → 403
    await expect(apartmentsSvc.create(agent(), b.id, apt)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // toggle ON → allowed
    await membersSvc.updateCapabilities(manager(), agentId, { edit_project_data: true });
    const a = await apartmentsSvc.create(agent(), b.id, apt);
    expect(a.id).toBeTruthy();
  }, 30_000);

  it('D46-CAP-7) capability toggle is AGENT-only (manager target → 400)', async () => {
    await expect(
      membersSvc.updateCapabilities(manager(), managerId, { edit_project_data: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // D.54 invariant — view_owner_pii (reveal cleartext) ⇒ view_owners (see owners).
  it('D54-INV-1) grant view_owner_pii while view_owners is on (default) → ok', async () => {
    const u = await membersSvc.updateCapabilities(manager(), agentId, { view_owner_pii: true });
    expect(u.capabilities?.view_owner_pii).toBe(true);
    expect(u.capabilities?.view_owners).toBe(true);
  });

  it('D54-INV-2) turning view_owners OFF while view_owner_pii is on → 400 (contradiction)', async () => {
    // agent is {view_owners:true, view_owner_pii:true} from INV-1.
    await expect(
      membersSvc.updateCapabilities(manager(), agentId, { view_owners: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('D54-INV-3) {view_owners:false, view_owner_pii:true} in ONE patch → 400', async () => {
    await expect(
      membersSvc.updateCapabilities(manager(), agentId, {
        view_owners: false,
        view_owner_pii: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('D54-INV-4) turning BOTH off together → ok (no contradiction)', async () => {
    const u = await membersSvc.updateCapabilities(manager(), agentId, {
      view_owner_pii: false,
      view_owners: false,
    });
    expect(u.capabilities?.view_owners).toBe(false);
    expect(u.capabilities?.view_owner_pii).toBe(false);
  });
});
