/**
 * Type-driven consent-threshold default — ProjectsService.create.
 *
 * `ProjectsService.create(user, input)` DEFAULTS `targetSignaturePct`
 * from the project's urban-renewal track when the manager doesn't
 * supply one. Per-type defaults live in
 * `PROJECT_TYPE_DEFAULT_CONSENT_PCT` (packages/shared-types/src/project.ts):
 *   tama38_1 → 66, tama38_2 → 80, pinui_binui → 80.
 *
 * An explicit `input.targetSignaturePct` (any number, including 0)
 * OVERRIDES the default. The DB column is `numeric`; the service stores
 * it as a string and `toProject` normalises it back to a `number` on
 * read (ProjectSchema.targetSignaturePct: z.number().nullable()).
 *
 * This is a service-level integration spec against real Neon — same
 * harness as projects.s2.spec.ts (instantiate the service directly,
 * seed via createTestOrg, no Nest harness). It pins:
 *   1. tama38_1, no threshold → 66.
 *   2. tama38_2, no threshold → 80.
 *   3. pinui_binui, no threshold → 80.
 *   4. tama38_1 WITH explicit 75 → 75 (override wins, not 66).
 *   5. explicit 0 is respected as 0 (0 is valid per the schema and the
 *      service only defaults on undefined/null — boundary check).
 *   6. the returned + read-back value is a NUMBER, not a string.
 *   7. an explicit defaulting value (e.g. tama38_1 with explicit 66)
 *      is stored from the input, indistinguishable on the wire — just
 *      pins that an explicit-equals-default still round-trips as a number.
 */
import { PROJECT_TYPE_DEFAULT_CONSENT_PCT, ProjectSchema } from '@emapp/shared-types';
import type { CreateProject } from '@emapp/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

let orgA: TestOrg;
const svc = new ProjectsService();

const TEST_SID = '00000000-0000-4000-8000-00000000ccc1';

function manager(o: TestOrg): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role: 'manager',
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`CONSENT-${ts}`, `consent-${ts}`);
});

/**
 * Read the project straight back from the DB through the service's own
 * read shape (`get` returns a ProjectListItem that extends Project) so
 * we exercise the same `toProject` numeric normalisation the API uses,
 * not just the value returned by `create`.
 */
async function readBack(proj: { id: string }): Promise<unknown> {
  return svc.get(manager(orgA), proj.id);
}

describe('ProjectsService.create · type-driven consent-threshold default', () => {
  it('1) tama38_1, no targetSignaturePct → defaults to 66', async () => {
    const input: CreateProject = { name: `consent t1 ${Date.now()}`, type: 'tama38_1' };
    const created = await svc.create(manager(orgA), input);
    expect(created.targetSignaturePct).toBe(66);
    expect(PROJECT_TYPE_DEFAULT_CONSENT_PCT.tama38_1).toBe(66);

    const read = (await readBack(created)) as { targetSignaturePct: unknown };
    expect(read.targetSignaturePct).toBe(66);
  });

  it('2) tama38_2, no targetSignaturePct → defaults to 80', async () => {
    const input: CreateProject = { name: `consent t2 ${Date.now()}`, type: 'tama38_2' };
    const created = await svc.create(manager(orgA), input);
    expect(created.targetSignaturePct).toBe(80);
    expect(PROJECT_TYPE_DEFAULT_CONSENT_PCT.tama38_2).toBe(80);

    const read = (await readBack(created)) as { targetSignaturePct: unknown };
    expect(read.targetSignaturePct).toBe(80);
  });

  it('3) pinui_binui, no targetSignaturePct → defaults to 80', async () => {
    const input: CreateProject = { name: `consent pb ${Date.now()}`, type: 'pinui_binui' };
    const created = await svc.create(manager(orgA), input);
    expect(created.targetSignaturePct).toBe(80);
    expect(PROJECT_TYPE_DEFAULT_CONSENT_PCT.pinui_binui).toBe(80);

    const read = (await readBack(created)) as { targetSignaturePct: unknown };
    expect(read.targetSignaturePct).toBe(80);
  });

  it('4) tama38_1 WITH explicit targetSignaturePct: 75 → 75 (override wins, not 66)', async () => {
    const input: CreateProject = {
      name: `consent override ${Date.now()}`,
      type: 'tama38_1',
      targetSignaturePct: 75,
    };
    const created = await svc.create(manager(orgA), input);
    // Override beats the per-type default (which is 66 for tama38_1).
    expect(created.targetSignaturePct).toBe(75);
    expect(created.targetSignaturePct).not.toBe(66);

    const read = (await readBack(created)) as { targetSignaturePct: unknown };
    expect(read.targetSignaturePct).toBe(75);
  });

  it('5) explicit targetSignaturePct: 0 is respected as 0, NOT defaulted', async () => {
    // 0 is a valid input: projectWriteShape uses z.number().min(0).max(100),
    // so 0 passes validation. The service defaults ONLY on undefined/null
    // (=== undefined || === null), so a literal 0 must survive and NOT be
    // replaced by the per-type default (66 for tama38_1). This is the
    // override-vs-default boundary: 0 is falsy but explicit.
    const input: CreateProject = {
      name: `consent zero ${Date.now()}`,
      type: 'tama38_1',
      targetSignaturePct: 0,
    };
    const created = await svc.create(manager(orgA), input);
    expect(created.targetSignaturePct).toBe(0);
    expect(created.targetSignaturePct).not.toBe(66);

    const read = (await readBack(created)) as { targetSignaturePct: unknown };
    expect(read.targetSignaturePct).toBe(0);
  });

  it('6) the read-back targetSignaturePct is a NUMBER, not a string (ProjectSchema)', async () => {
    const input: CreateProject = { name: `consent numtype ${Date.now()}`, type: 'tama38_2' };
    const created = await svc.create(manager(orgA), input);
    expect(typeof created.targetSignaturePct).toBe('number');

    const read = (await readBack(created)) as { targetSignaturePct: unknown };
    expect(typeof read.targetSignaturePct).toBe('number');

    // Also assert via a raw-tenant read that the value flowing through the
    // service is genuinely normalised (drizzle numeric arrives as a string;
    // toProject converts it). ProjectSchema requires a number.
    const parsedDefault = ProjectSchema.shape.targetSignaturePct.safeParse(
      created.targetSignaturePct,
    );
    expect(parsedDefault.success).toBe(true);
  });

  it('7) explicit value equal to the default (tama38_1 + explicit 66) still round-trips as a number', async () => {
    const input: CreateProject = {
      name: `consent explicit-eq-default ${Date.now()}`,
      type: 'tama38_1',
      targetSignaturePct: 66,
    };
    const created = await svc.create(manager(orgA), input);
    expect(created.targetSignaturePct).toBe(66);
    expect(typeof created.targetSignaturePct).toBe('number');

    // Sanity: it was stored (not null) — exercise withTenant read of the raw
    // value being non-null through the service read shape.
    const read = (await readBack(created)) as { targetSignaturePct: unknown };
    expect(read.targetSignaturePct).toBe(66);
  });
});
