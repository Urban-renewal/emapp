/**
 * wave-2.4 future-states — building-permit (היתר בנייה) tracking fields, service
 * round-trip + role-gate. Same direct-service harness as
 * projects-renewal-fields.spec.ts (no Nest harness; seed via createTestOrg).
 *
 * Pins:
 *   A) create defaults: a project created WITHOUT permit fields reads back
 *      permitStatus='none', both dates null (backward-compat).
 *   B) update SETs the permit status + dates, then read-back is identical.
 *   C) update can CLEAR the dates (null) + move status back to 'none'.
 *   D) ROLE-GATE: an agent/viewer update is FORBIDDEN (manager-only write).
 */
import type { UpdateProject } from '@emapp/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

let orgA: TestOrg;
const svc = new ProjectsService();

const TEST_SID = '00000000-0000-4000-8000-00000000ddd2';

function userAs(o: TestOrg, role: 'manager' | 'agent' | 'viewer'): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role,
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`PERMIT-${ts}`, `permit-${ts}`);
});

describe('ProjectsService — building-permit fields (migration 0083)', () => {
  it('A) create WITHOUT permit fields → permitStatus none, dates null (backward-compat)', async () => {
    const created = await svc.create(userAs(orgA, 'manager'), {
      name: `permit minimal ${Date.now()}`,
      type: 'tama38_1',
    });
    expect(created.permitStatus).toBe('none');
    expect(created.permitAppliedAt).toBeNull();
    expect(created.permitExpiryAt).toBeNull();
  });

  it('B) update SETs permit status + dates; read-back is identical', async () => {
    const created = await svc.create(userAs(orgA, 'manager'), {
      name: `permit set ${Date.now()}`,
      type: 'tama38_2',
    });
    const appliedAt = new Date('2026-01-15T00:00:00.000Z');
    const expiryAt = new Date('2026-07-15T00:00:00.000Z');
    const patch: UpdateProject = {
      permitStatus: 'approved',
      permitAppliedAt: appliedAt,
      permitExpiryAt: expiryAt,
    };
    const updated = await svc.update(userAs(orgA, 'manager'), created.id, patch);
    expect(updated.permitStatus).toBe('approved');
    expect(updated.permitAppliedAt?.toISOString()).toBe(appliedAt.toISOString());
    expect(updated.permitExpiryAt?.toISOString()).toBe(expiryAt.toISOString());

    const read = (await svc.get(userAs(orgA, 'manager'), created.id)) as typeof updated;
    expect(read.permitStatus).toBe('approved');
    expect(read.permitExpiryAt?.toISOString()).toBe(expiryAt.toISOString());
  });

  it('C) update can CLEAR the dates and move status back to none', async () => {
    const created = await svc.create(userAs(orgA, 'manager'), {
      name: `permit clear ${Date.now()}`,
      type: 'tama38_1',
    });
    await svc.update(userAs(orgA, 'manager'), created.id, {
      permitStatus: 'applied',
      permitAppliedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const cleared = await svc.update(userAs(orgA, 'manager'), created.id, {
      permitStatus: 'none',
      permitAppliedAt: null,
      permitExpiryAt: null,
    });
    expect(cleared.permitStatus).toBe('none');
    expect(cleared.permitAppliedAt).toBeNull();
    expect(cleared.permitExpiryAt).toBeNull();
  });

  it('D) role-gate: a non-manager update is forbidden', async () => {
    const created = await svc.create(userAs(orgA, 'manager'), {
      name: `permit gate ${Date.now()}`,
      type: 'tama38_1',
    });
    await expect(
      svc.update(userAs(orgA, 'agent'), created.id, { permitStatus: 'approved' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.update(userAs(orgA, 'viewer'), created.id, { permitStatus: 'approved' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
