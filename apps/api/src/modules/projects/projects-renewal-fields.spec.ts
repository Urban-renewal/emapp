/**
 * P3 create-form enrichment (migration 0062) — round-trip + backward-compat.
 *
 * Service-level integration spec against real Neon (same harness as
 * projects-type-consent-default.spec.ts: instantiate the service directly,
 * seed via createTestOrg, no Nest harness). Pins the contract of the five new
 * optional/nullable field groups added to `projects`:
 *   1. developer / יזם           — developerName, developerCompanyId
 *   2. unit / תמורה ratio        — existingUnits, plannedUnits, extraAreaSqm
 *   3. relocation / פינוי        — relocationType (enum), relocationNotes
 *   4. future-track              — type 'other' + typeLabel
 *   5. parcel provenance / גוש-חלקה — block, parcel, subparcel
 *
 * Two axes, both required by the DoD:
 *   A) create WITH the new fields round-trips (create → read-back identical).
 *   B) create WITHOUT them still works (backward-compat: every field null).
 *   C) update can set + clear (null) the fields.
 */
import type { CreateProject, UpdateProject } from '@emapp/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

let orgA: TestOrg;
const svc = new ProjectsService();

const TEST_SID = '00000000-0000-4000-8000-00000000ddd1';

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
  orgA = await createTestOrg(`RENEW-${ts}`, `renew-${ts}`);
});

describe('ProjectsService — P3 renewal fields (migration 0062)', () => {
  it('A) create WITH all new fields round-trips through create + read-back', async () => {
    const input: CreateProject = {
      name: `renew full ${Date.now()}`,
      type: 'pinui_binui',
      developerName: 'חברת יזמות בע"מ',
      developerCompanyId: '514987654',
      existingUnits: 20,
      plannedUnits: 48,
      extraAreaSqm: 12.5,
      relocationType: 'alt_housing',
      relocationNotes: 'דיור חלופי במרחק הליכה',
      block: '6941',
      parcel: '88',
      subparcel: '2',
    };
    const created = await svc.create(manager(orgA), input);
    expect(created.developerName).toBe('חברת יזמות בע"מ');
    expect(created.developerCompanyId).toBe('514987654');
    expect(created.existingUnits).toBe(20);
    expect(created.plannedUnits).toBe(48);
    expect(created.extraAreaSqm).toBe(12.5);
    expect(typeof created.extraAreaSqm).toBe('number'); // numeric normalised
    expect(created.relocationType).toBe('alt_housing');
    expect(created.relocationNotes).toBe('דיור חלופי במרחק הליכה');
    expect(created.block).toBe('6941');
    expect(created.parcel).toBe('88');
    expect(created.subparcel).toBe('2');

    const read = (await svc.get(manager(orgA), created.id)) as typeof created;
    expect(read.developerName).toBe('חברת יזמות בע"מ');
    expect(read.existingUnits).toBe(20);
    expect(read.plannedUnits).toBe(48);
    expect(read.extraAreaSqm).toBe(12.5);
    expect(read.relocationType).toBe('alt_housing');
    expect(read.block).toBe('6941');
    expect(read.subparcel).toBe('2');
  });

  it('A2) future-track: type "other" + typeLabel round-trips (additive enum value)', async () => {
    const input: CreateProject = {
      name: `renew other ${Date.now()}`,
      type: 'other',
      typeLabel: 'חלופת שקד',
    };
    const created = await svc.create(manager(orgA), input);
    expect(created.type).toBe('other');
    expect(created.typeLabel).toBe('חלופת שקד');

    const read = (await svc.get(manager(orgA), created.id)) as typeof created;
    expect(read.type).toBe('other');
    expect(read.typeLabel).toBe('חלופת שקד');
  });

  it('B) create WITHOUT the new fields still works — every new field is null (backward-compat)', async () => {
    // The exact pre-feature minimal create shape.
    const input: CreateProject = { name: `renew minimal ${Date.now()}`, type: 'tama38_1' };
    const created = await svc.create(manager(orgA), input);
    expect(created.developerName).toBeNull();
    expect(created.developerCompanyId).toBeNull();
    expect(created.existingUnits).toBeNull();
    expect(created.plannedUnits).toBeNull();
    expect(created.extraAreaSqm).toBeNull();
    expect(created.relocationType).toBeNull();
    expect(created.relocationNotes).toBeNull();
    expect(created.typeLabel).toBeNull();
    expect(created.block).toBeNull();
    expect(created.parcel).toBeNull();
    expect(created.subparcel).toBeNull();

    const read = (await svc.get(manager(orgA), created.id)) as typeof created;
    expect(read.developerName).toBeNull();
    expect(read.relocationType).toBeNull();
    expect(read.block).toBeNull();
  });

  it('C) update can SET then CLEAR (null) the new fields', async () => {
    const created = await svc.create(manager(orgA), {
      name: `renew update ${Date.now()}`,
      type: 'tama38_2',
    });
    expect(created.developerName).toBeNull();

    const setPatch: UpdateProject = {
      developerName: 'יזם חדש',
      existingUnits: 10,
      plannedUnits: 22,
      relocationType: 'rent_comp',
      block: '1234',
    };
    const updated = await svc.update(manager(orgA), created.id, setPatch);
    expect(updated.developerName).toBe('יזם חדש');
    expect(updated.existingUnits).toBe(10);
    expect(updated.plannedUnits).toBe(22);
    expect(updated.relocationType).toBe('rent_comp');
    expect(updated.block).toBe('1234');

    const clearPatch: UpdateProject = {
      developerName: null,
      existingUnits: null,
      relocationType: null,
      block: null,
    };
    const cleared = await svc.update(manager(orgA), created.id, clearPatch);
    expect(cleared.developerName).toBeNull();
    expect(cleared.existingUnits).toBeNull();
    expect(cleared.relocationType).toBeNull();
    expect(cleared.block).toBeNull();
    // A field NOT in the patch is left unchanged (plannedUnits stays 22).
    expect(cleared.plannedUnits).toBe(22);
  });
});
