/**
 * NATURAL (numeric-aware) APARTMENT-NUMBER ORDERING — independent acceptance
 * spec, authored FIRST (RED against current code). Does NOT touch the
 * implementation. Branch: fix/numeric-apartment-sort.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 * `apartments.number` is TEXT (free label: '2', '10', 'דירה 7', '7א'). Every
 * place that orders by it today sorts LEXICALLY, so '10' lands before '2' and
 * 'דירה 10' before 'דירה 2'. Grounded in-scope sites (grep `ORDER BY` /
 * `orderBy` on apartments.number, 2026-06-12):
 *
 *   1. ProjectsService.signatureProgressApartments (S5d drill-down)
 *      apps/api/src/modules/projects/projects.service.ts — `ORDER BY a.number ASC`
 *   2. ContractorReadService.getProject (contractor portal project view)
 *      apps/api/src/modules/contractor-portal/contractor-read.service.ts
 *      — `.orderBy(asc(apartments.number))`
 *
 * HONEST OUT-OF-SCOPE NOTE — ApartmentsService.list
 * (apps/api/src/modules/apartments/apartments.service.ts) orders by
 * `createdAt DESC, id DESC` (keyset pagination cursor), NOT by number. It is
 * NOT lexically broken and is NOT pinned here; making it number-ordered would
 * be a cursor-contract change, out of this slice.
 *
 * ── THE PINNED CONTRACT (behavior, not mechanism) ──────────────────────────
 * Order apartments by their EXTRACTED NUMERAL first, label second:
 *
 *   key       = the integer formed by the digits in `number`
 *               (e.g. '10'→10, 'דירה 3'→3, '7א'→7); digitless → NULL
 *   ordering  = key ASC NULLS LAST, then `number` ASC (lexical tie-break)
 *
 * One SQL realisation (the reference mechanism, NOT mandated):
 *   ORDER BY NULLIF(regexp_replace(number, '\D', '', 'g'), '')::bigint
 *            NULLS LAST, number
 *
 * Pinned TOTAL order for the seed set
 *   { '1','2','3','דירה 3','7','7א','10','דירה 21','מחסן' }:
 *
 *   '1' < '2' < '3' < 'דירה 3' < '7' < '7א' < '10' < 'דירה 21' < 'מחסן'
 *
 * Documented tie-breaks (equal extracted numeral → lexical on the raw label):
 *   key 3: '3' before 'דירה 3'  (ASCII digits precede Hebrew letters under
 *                                both byte order and ICU — stable either way)
 *   key 7: '7' before '7א'      ('7' is a strict prefix → first under any
 *                                collation)
 *   digitless 'מחסן' → key NULL → LAST.
 *
 * MECHANISM NOTE (for the builder): a pure ICU numeric collation
 * (`-u-kn-true`) does NOT satisfy this contract for mixed labels — it
 * compares 'דירה 3' by its leading LETTER, pushing every 'דירה N' after all
 * digit-leading labels ('10' < 'דירה 3'). No kn-true collation exists in
 * migrations today (grepped; 0013 he_il_icu is deterministic=false WITHOUT
 * numeric ordering). The numeric-prefix-extraction ORDER BY (or equivalent)
 * is the shape that produces the pinned interleaved order.
 *
 * ── RED PROOF ──────────────────────────────────────────────────────────────
 * Today both sites return lexical order, which puts '10' immediately after
 * '1' and before '2' — the array-equality assertions below fail until the
 * natural ordering lands.
 *
 * ── HARNESS ────────────────────────────────────────────────────────────────
 * Sibling of projects-signature-progress-apartments.spec.ts (proven seeding
 * harness — raw SQL via providerPool for buildings/apartments/ownerships,
 * withTenant+drizzle for the PII-encrypted owner). Apartments are INSERTED in
 * scrambled order so neither insertion order nor createdAt can accidentally
 * satisfy the assertion. Each apartment gets ONE active 'owner' ownership
 * (100%) so drill-down rows are realistic (totalOwners=1).
 */
import { randomUUID } from 'node:crypto';

import {
  contractors,
  defaultSharePermissions,
  encryptOwnerPii,
  owners,
  shares,
  withTenant,
  type IStorageProvider,
} from '@emapp/db';
import type { SharePermissions } from '@emapp/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import type { ContractorContext } from '../contractor-portal/contractor-auth.guard';
import { ContractorReadService } from '../contractor-portal/contractor-read.service';

import { ProjectsService } from './projects.service';

/**
 * Seed labels in deliberately SCRAMBLED insert order (≠ lexical, ≠ natural),
 * so only a genuinely numeric-aware ORDER BY can produce the pinned order.
 */
const SEED_NUMBERS = ['10', 'מחסן', 'דירה 21', '2', '7א', 'דירה 3', '1', '3', '7'] as const;

/** The pinned NATURAL total order (see header: key ASC NULLS LAST, then label). */
const NATURAL_ORDER = ['1', '2', '3', 'דירה 3', '7', '7א', '10', 'דירה 21', 'מחסן'] as const;

const fakeStorage: IStorageProvider = {
  getUploadUrl: async () => ({ url: 'https://r2.test/upload', fields: {} }) as never,
  getDownloadUrl: async () => 'https://r2.test/download?sig=abc',
  deleteObject: async () => {},
  headObject: async () => ({ size: 1, contentType: 'application/pdf' }) as never,
} as unknown as IStorageProvider;

let projectsSvc: ProjectsService;
let contractorSvc: ContractorReadService;
let org: TestOrg;
let managerId: string;

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-0000000000f1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedBuilding(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
      [projectId, `St-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedApartment(buildingId: string, number: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number, floor) VALUES ($1, $2, 1) RETURNING id`,
      [buildingId, number],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

// org-unique active national_id (owners_org_natid_unique_active) — one per call.
let nidCounter = 400000301;

/** One PII-encrypted owner, reused across apartments (1 active ownership each). */
async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const enc = await encryptOwnerPii(tx as never, {
      nationalId: String(nidCounter++),
      name: 'בעלים-מיון',
      phone: '0547770001',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        email: `owner-sort-${randomUUID()}@test.local`,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function seedOwnership(apartmentId: string, ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship)
       VALUES ($1, $2, '100.00', 'owner')`,
      [apartmentId, ownerId],
    );
  } finally {
    c.release();
  }
}

/** Seed the scrambled apartment set (+1 active owner each) on a fresh building. */
async function seedScrambledApartments(projectId: string): Promise<string> {
  const buildingId = await seedBuilding(projectId);
  const ownerId = await seedOwner(org.id);
  for (const number of SEED_NUMBERS) {
    const aptId = await seedApartment(buildingId, number);
    await seedOwnership(aptId, ownerId);
  }
  return buildingId;
}

const FULL_PERMS = (): SharePermissions => ({
  ...defaultSharePermissions(),
  overview: { on: true },
});

beforeAll(async () => {
  await setupTestDatabase();
  projectsSvc = new ProjectsService();
  contractorSvc = new ContractorReadService(fakeStorage);
  const tag = `apt-natsort-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// #1 — S5d drill-down: signatureProgressApartments returns NATURAL order
//      (RED today: `ORDER BY a.number ASC` is lexical → '10' before '2')
// ───────────────────────────────────────────────────────────────────────────
describe('apartment natural sort — signature-progress drill-down (S5d)', () => {
  it('returns apartments in natural numeric order, not lexical', async () => {
    const projectId = org.projects[0]!.id;
    await seedScrambledApartments(projectId);

    const rows = await projectsSvc.signatureProgressApartments(manager(), projectId);

    // The fresh project contains EXACTLY our seeds → assert the full order.
    expect(rows.map((r) => r.number)).toEqual([...NATURAL_ORDER]);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #2 — contractor portal project view: apartments per building in NATURAL
//      order (RED today: `.orderBy(asc(apartments.number))` is lexical)
// ───────────────────────────────────────────────────────────────────────────
describe('apartment natural sort — contractor portal project view', () => {
  it('lists each building’s apartments in natural numeric order, not lexical', async () => {
    const projectId = org.projects[1]!.id;
    const buildingId = await seedScrambledApartments(projectId);

    // Minimal live share so ContractorReadService accepts the context.
    const ctx = await withTenant(org.id, async (tx) => {
      const [c] = await tx
        .insert(contractors)
        .values({
          orgId: org.id,
          name: 'SortCo',
          contactEmail: `sortco-${randomUUID()}@test.local`,
          createdBy: managerId,
        })
        .returning({ id: contractors.id });
      const [sh] = await tx
        .insert(shares)
        .values({
          projectId,
          contractorId: c!.id,
          permissions: defaultSharePermissions(),
          createdBy: managerId,
        })
        .returning({ id: shares.id });
      return {
        contractorId: c!.id,
        projectId,
        shareId: sh!.id,
        orgId: org.id,
        permissions: FULL_PERMS(),
      } satisfies ContractorContext;
    });

    const view = await contractorSvc.getProject(ctx);

    const building = view.buildings.find((b) => b.id === buildingId);
    expect(building).toBeDefined();
    expect(building!.apartments.map((a) => a.number)).toEqual([...NATURAL_ORDER]);
  }, 60_000);
});
