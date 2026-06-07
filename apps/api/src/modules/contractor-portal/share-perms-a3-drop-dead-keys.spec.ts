/**
 * A3 (L4) — ADVERSARIAL test-author spec (real DB). Separate from the builder.
 *
 * Proves the four A3 invariants the builder claims:
 *   1. Migration 0052 jsonb-cleanup strips the DEAD keys (`tenants` incl. its
 *      `fields.national_id` PII footgun, `notes`, `team`,
 *      `documents.actions.upload`) from EVERY `shares.permissions` row, leaves
 *      live keys EXACTLY, is a byte no-op on already-clean rows, and is
 *      idempotent (2nd run touches 0 rows). Real DB.
 *   2. The contractor read-path STILL works for the live perm set (no
 *      regression) — overview + documents{download} + signatures.
 *   3. A dead perm grants NOTHING: the strict schema REJECTS any `tenants` /
 *      `national_id` / `notes` / `team` / `upload` key (fail-closed), and the
 *      contractor view types carry no field for owner/resident/national_id.
 *   4. No `national_id` reaches a contractor on ANY contractor-facing surface.
 *
 * The migration assertions run the EXACT cleanup SQL from
 * packages/db/migrations/0052_shares_perms_drop_dead_keys.sql against rows we
 * seed with raw jsonb (the typed Drizzle insert can't carry dead keys, so we
 * inject via `tx.execute(sql)` — exactly the shape a pre-migration prod row
 * has). Scoped to our own seeded share ids; unique/far-future data.
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  contractors,
  documents,
  encryptOwnerPii,
  owners,
  ownerships,
  resolveSharePermissions,
  signatureRequests,
  sql,
  withTenant,
  type IStorageProvider,
} from '@emapp/db';
import { SharePermissionsSchema, type SharePermissions } from '@emapp/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ContractorContext } from './contractor-auth.guard';
import { ContractorReadService } from './contractor-read.service';

// `resolveSharePermissions(raw)` === `dbSideSchema.parse(raw)` — the DB-side
// gate on every share READ. It THROWS on a dead key, so we wrap it to get a
// boolean parity check against the shared-types `.safeParse`.
function dbSideAccepts(blob: unknown): boolean {
  try {
    resolveSharePermissions(blob);
    return true;
  } catch {
    return false;
  }
}

const NID = '309876541'; // unique national_id for the footgun assertions
const PHONE = '0529998877';

const fakeStorage: IStorageProvider = {
  getUploadUrl: async () => ({ url: 'https://r2.test/upload', fields: {} }) as never,
  getDownloadUrl: async () => 'https://r2.test/download?sig=a3',
  deleteObject: async () => {},
  headObject: async () => ({ size: 1, contentType: 'application/pdf' }) as never,
} as unknown as IStorageProvider;

// The EXACT cleanup SQL body from 0052_shares_perms_drop_dead_keys.sql. We add
// a `share_id = ANY($ids)` clause so it touches ONLY rows this spec seeded
// (dev DB carries unrelated shares). The transform + WHERE predicate are
// otherwise byte-identical to the migration. Returns the rows it changed so
// we can assert the touched-count (idempotency).
async function runCleanup(orgId: string, shareIds: string[]): Promise<number> {
  return withTenant(orgId, async (tx) => {
    let touched = 0;
    for (const id of shareIds) {
      // Body byte-identical to migration 0052; only the `WHERE id =` clause is
      // scoped to ONE seeded row at a time so it never mutates dev-DB shares.
      const res = await tx.execute(sql`
        UPDATE shares
        SET permissions =
              (permissions - 'tenants' - 'notes' - 'team') #- '{documents,actions,upload}'
        WHERE id = ${id}::uuid
          AND ( permissions ? 'tenants'
             OR permissions ? 'notes'
             OR permissions ? 'team'
             OR permissions #> '{documents,actions}' ? 'upload' )
      `);
      touched += res.rowCount ?? 0;
    }
    return touched;
  });
}

async function readPerms(orgId: string, shareId: string): Promise<unknown> {
  return withTenant(orgId, async (tx) => {
    const r = await tx.execute<{ permissions: unknown }>(
      sql`SELECT permissions FROM shares WHERE id = ${shareId}::uuid LIMIT 1`,
    );
    return (r.rows[0] as { permissions: unknown } | undefined)?.permissions;
  });
}

let svc: ContractorReadService;
let orgA: TestOrg;

const fx = {
  projectId: '',
  contractorId: '',
  // share with the full pre-migration DEAD-key blob
  dirtyShareId: '',
  // share already in the clean new shape (must be byte-unchanged)
  cleanShareId: '',
  // dead-key row whose `documents` has NO `actions` path (proves the nested
  // `#- '{documents,actions,upload}'` is a safe no-op when the path is absent)
  partialShareId: '',
  // share used to drive the live contractor read-path (no regression)
  liveShareId: '',
  projectDocId: '',
  apartmentDocId: '',
  ownerId: '',
};

// A realistic PRE-migration row: live keys PLUS every dead key, including the
// national_id PII footgun nested under tenants.fields.
const DIRTY_BLOB = {
  overview: { on: true },
  documents: { on: true, actions: { download: true, upload: true } },
  signatures: { on: true },
  tenants: { on: true, fields: { national_id: true, phone: true, email: true } },
  notes: { on: true },
  team: { on: true },
};

// A row already in the post-migration clean shape.
const CLEAN_BLOB = {
  overview: { on: true },
  documents: { on: false, actions: { download: true } },
  signatures: { on: true },
};

// A dead-key row of a DIFFERENT shape: it carries `tenants` but its
// `documents` has NO `actions` sub-object at all. Proves the migration's
// nested `#- '{documents,actions,upload}'` does not error / mangle a row
// where that path is absent (completeness across row shapes).
const PARTIAL_BLOB = {
  overview: { on: false },
  documents: { on: false },
  signatures: { on: false },
  tenants: { on: true, fields: { national_id: true } },
};

async function seedShareRaw(
  orgId: string,
  projectId: string,
  contractorId: string,
  createdBy: string,
  blob: unknown,
): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO shares (project_id, contractor_id, permissions, created_by)
      VALUES (${projectId}::uuid, ${contractorId}::uuid, ${JSON.stringify(blob)}::jsonb, ${createdBy}::uuid)
      RETURNING id
    `);
    return (r.rows[0] as { id: string }).id;
  });
}

async function seed(): Promise<void> {
  await withTenant(orgA.id, async (tx) => {
    fx.projectId = orgA.projects[0]!.id;
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId: fx.projectId,
        address: 'A3 Adversarial 99',
        city: 'Haifa',
        block: '9999',
        parcel: '777',
      })
      .returning({ id: buildings.id });
    const [apt] = await tx
      .insert(apartments)
      .values({ buildingId: bld!.id, number: '13', floor: 3 })
      .returning({ id: apartments.id });

    const enc = await encryptOwnerPii(tx as never, {
      name: 'אבי פוטגון',
      nationalId: NID,
      phone: PHONE,
    });
    const [own] = await tx
      .insert(owners)
      .values({
        orgId: orgA.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
      })
      .returning({ id: owners.id });
    await tx
      .insert(ownerships)
      .values({ apartmentId: apt!.id, ownerId: own!.id, ownershipPct: '100', role: 'owner' });
    fx.ownerId = own!.id;

    const mkDoc = async (opts: { projectId?: string; apartmentId?: string; name: string }) => {
      const [d] = await tx
        .insert(documents)
        .values({
          orgId: orgA.id,
          projectId: opts.projectId ?? null,
          apartmentId: opts.apartmentId ?? null,
          name: opts.name,
          type: 'contract',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          r2Key: `org/${orgA.id}/doc/${randomUUID()}.pdf`,
          contentHash: 'sha256:' + 'e'.repeat(64),
          uploadedBy: orgA.users[0]!.id,
          uploadedAt: new Date(),
        })
        .returning({ id: documents.id });
      return d!.id;
    };
    fx.projectDocId = await mkDoc({ projectId: fx.projectId, name: 'A3 Project Plan' });
    fx.apartmentDocId = await mkDoc({ apartmentId: apt!.id, name: 'A3 Per-owner Agreement' });

    const mkSr = async (status: 'signed' | 'pending' | 'cancelled') => {
      await tx.insert(signatureRequests).values({
        orgId: orgA.id,
        documentId: fx.apartmentDocId,
        ownerId: own!.id,
        jti: `jti-${randomUUID()}`,
        status,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        createdBy: orgA.users[0]!.id,
      });
    };
    await mkSr('signed');
    await mkSr('pending');
    await mkSr('cancelled');

    const [c] = await tx
      .insert(contractors)
      .values({
        orgId: orgA.id,
        name: 'A3-AdversaryCo',
        contactEmail: `a3-${randomUUID()}@test.local`,
        createdBy: orgA.users[0]!.id,
      })
      .returning({ id: contractors.id });
    fx.contractorId = c!.id;
  });

  // Three contractor entities needed: the `shares_project_contractor_active`
  // unique index forbids two active shares for the same (project, contractor).
  const mkContractor = async () =>
    withTenant(orgA.id, async (tx) => {
      const [c] = await tx
        .insert(contractors)
        .values({
          orgId: orgA.id,
          name: `A3-${randomUUID().slice(0, 8)}`,
          contactEmail: `a3-${randomUUID()}@test.local`,
          createdBy: orgA.users[0]!.id,
        })
        .returning({ id: contractors.id });
      return c!.id;
    });

  const cDirty = fx.contractorId;
  const cClean = await mkContractor();
  const cLive = await mkContractor();
  const cPartial = await mkContractor();
  const createdBy = orgA.users[0]!.id;

  fx.dirtyShareId = await seedShareRaw(orgA.id, fx.projectId, cDirty, createdBy, DIRTY_BLOB);
  fx.cleanShareId = await seedShareRaw(orgA.id, fx.projectId, cClean, createdBy, CLEAN_BLOB);
  fx.partialShareId = await seedShareRaw(orgA.id, fx.projectId, cPartial, createdBy, PARTIAL_BLOB);
  // Live share = canonical default + documents ON (so download works).
  fx.liveShareId = await seedShareRaw(orgA.id, fx.projectId, cLive, createdBy, {
    overview: { on: true },
    documents: { on: true, actions: { download: true } },
    signatures: { on: true },
  });
}

function ctx(shareId: string, perms: SharePermissions): ContractorContext {
  return {
    contractorId: fx.contractorId,
    projectId: fx.projectId,
    shareId,
    orgId: orgA.id,
    permissions: perms,
  };
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ContractorReadService(fakeStorage);
  orgA = await createTestOrg(`a3dead-${Date.now()}`, `a3dead-${Date.now()}`);
  await seed();
}, 90_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

const DEAD_TOP_KEYS = ['tenants', 'notes', 'team'] as const;

function assertNoDeadKeys(perms: unknown): void {
  const blob = JSON.stringify(perms);
  // No dead top-level key.
  for (const k of DEAD_TOP_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(perms as object, k)).toBe(false);
  }
  // No upload action.
  const docs = (perms as { documents?: { actions?: Record<string, unknown> } }).documents;
  expect(docs?.actions && Object.prototype.hasOwnProperty.call(docs.actions, 'upload')).toBeFalsy();
  // No national_id substring ANYWHERE (the PII footgun).
  expect(blob).not.toContain('national_id');
  expect(blob).not.toContain('tenants');
  expect(blob).not.toContain('notes');
  expect(blob).not.toContain('team');
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Migration jsonb-cleanup (real DB)
// ─────────────────────────────────────────────────────────────────────────
describe('A3 #1 — migration 0052 jsonb-cleanup (real DB)', () => {
  it('a pre-migration DIRTY row → exactly the live keys, ZERO dead keys / no national_id', async () => {
    // Pre-condition: the raw seed really did persist the dead keys (proves the
    // test is not vacuous — the typed insert would have stripped them).
    const before = await readPerms(orgA.id, fx.dirtyShareId);
    expect(Object.prototype.hasOwnProperty.call(before as object, 'tenants')).toBe(true);
    expect(JSON.stringify(before)).toContain('national_id');

    const touched = await runCleanup(orgA.id, [fx.dirtyShareId]);
    expect(touched).toBe(1); // the dirty row WAS rewritten

    const after = await readPerms(orgA.id, fx.dirtyShareId);
    assertNoDeadKeys(after);
    // Live keys present and EXACTLY the surviving shape.
    expect(after).toEqual({
      overview: { on: true },
      documents: { on: true, actions: { download: true } },
      signatures: { on: true },
    });
    // And the cleaned row re-parses cleanly against the NEW strict schema
    // (the DB-side gate every contractor read runs).
    expect(dbSideAccepts(after)).toBe(true);
  });

  it('an already-CLEAN row is byte-unchanged and not touched', async () => {
    const before = await readPerms(orgA.id, fx.cleanShareId);
    const touched = await runCleanup(orgA.id, [fx.cleanShareId]);
    expect(touched).toBe(0); // WHERE predicate skips clean rows
    const after = await readPerms(orgA.id, fx.cleanShareId);
    expect(after).toEqual(before); // byte-for-byte identical
    expect(after).toEqual(CLEAN_BLOB);
  });

  it('a dead-key row whose documents has NO actions path → strips tenants, leaves documents intact (completeness)', async () => {
    const before = await readPerms(orgA.id, fx.partialShareId);
    expect(Object.prototype.hasOwnProperty.call(before as object, 'tenants')).toBe(true);
    const touched = await runCleanup(orgA.id, [fx.partialShareId]);
    expect(touched).toBe(1);
    const after = await readPerms(orgA.id, fx.partialShareId);
    assertNoDeadKeys(after);
    // The nested `#-` no-op left the actions-less documents object exactly as is.
    expect(after).toEqual({
      overview: { on: false },
      documents: { on: false },
      signatures: { on: false },
    });
  });

  it('is idempotent — a 2nd run over all seeded rows touches 0 rows', async () => {
    const second = await runCleanup(orgA.id, [fx.dirtyShareId, fx.cleanShareId, fx.partialShareId]);
    expect(second).toBe(0);
    // State still correct after the no-op second pass.
    assertNoDeadKeys(await readPerms(orgA.id, fx.dirtyShareId));
    assertNoDeadKeys(await readPerms(orgA.id, fx.partialShareId));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Contractor-read still works for LIVE perms (no regression)
// ─────────────────────────────────────────────────────────────────────────
describe('A3 #2 — contractor read-path: live perms still work (no regression)', () => {
  const LIVE: SharePermissions = {
    overview: { on: true },
    documents: { on: true, actions: { download: true } },
    signatures: { on: true },
  };

  it('getProject returns overview structure; NO owner PII / national_id', async () => {
    const view = await svc.getProject(ctx(fx.liveShareId, LIVE));
    expect(view.project.id).toBe(fx.projectId);
    expect(view.buildings.length).toBeGreaterThanOrEqual(1);
    const blob = JSON.stringify(view);
    expect(blob).not.toContain(NID);
    expect(blob).not.toContain(PHONE);
    expect(blob).not.toContain('פוטגון');
    expect(blob).not.toContain('national_id');
  });

  it('getProgress returns aggregate counts (cancelled excluded)', async () => {
    const p = await svc.getProgress(ctx(fx.liveShareId, LIVE));
    expect(p.signaturesSigned).toBe(1);
    expect(p.signaturesPending).toBe(1);
    expect(p.signaturesTotal).toBe(2);
  });

  it('getDocuments returns the project doc; excludes the per-owner agreement', async () => {
    const { data } = await svc.getDocuments(ctx(fx.liveShareId, LIVE));
    const ids = data.map((d) => d.id);
    expect(ids).toContain(fx.projectDocId);
    expect(ids).not.toContain(fx.apartmentDocId);
  });

  it('getDownloadUrl mints a URL for the in-scope project doc', async () => {
    const r = await svc.getDownloadUrl(ctx(fx.liveShareId, LIVE), fx.projectDocId);
    expect(r.url).toContain('https://r2.test/download');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Dead perm grants NOTHING — schema fail-closed rejection
// ─────────────────────────────────────────────────────────────────────────
describe('A3 #3 — dead permission keys are structurally unreachable', () => {
  const LIVE = {
    overview: { on: true },
    documents: { on: true, actions: { download: true } },
    signatures: { on: true },
  };

  // Run every rejection against BOTH the shared-types schema (FE/BE DTO) and
  // the DB-side schema (resolveSharePermissions on read) — they MUST agree.
  const reject = (label: string, blob: unknown) => {
    it(`REJECTS ${label} (shared-types + db schema fail-closed)`, () => {
      expect(SharePermissionsSchema.safeParse(blob).success).toBe(false);
      expect(dbSideAccepts(blob)).toBe(false);
    });
  };

  reject('a tenants key with national_id', {
    ...LIVE,
    tenants: { on: true, fields: { national_id: true } },
  });
  reject('a bare tenants key', { ...LIVE, tenants: { on: true } });
  reject('a notes key', { ...LIVE, notes: { on: true } });
  reject('a team key', { ...LIVE, team: { on: true } });
  reject('documents.actions.upload', {
    ...LIVE,
    documents: { on: true, actions: { download: true, upload: true } },
  });
  reject('a stray national_id top-level key', { ...LIVE, national_id: true });

  it('ACCEPTS the live shape (positive control — not over-rejecting)', () => {
    expect(SharePermissionsSchema.safeParse(LIVE).success).toBe(true);
    expect(dbSideAccepts(LIVE)).toBe(true);
  });

  it('the parsed live perm object exposes no tenants/notes/team/upload field', () => {
    const parsed = SharePermissionsSchema.parse(LIVE);
    expect(parsed).not.toHaveProperty('tenants');
    expect(parsed).not.toHaveProperty('notes');
    expect(parsed).not.toHaveProperty('team');
    expect(parsed.documents.actions).not.toHaveProperty('upload');
    expect(Object.keys(parsed.documents.actions)).toEqual(['download']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. No national_id to a contractor — end-to-end across all surfaces
// ─────────────────────────────────────────────────────────────────────────
describe('A3 #4 — no national_id reaches a contractor on ANY surface', () => {
  const LIVE: SharePermissions = {
    overview: { on: true },
    documents: { on: true, actions: { download: true } },
    signatures: { on: true },
  };

  it('project + progress + documents serialized blobs contain no national_id', async () => {
    const project = await svc.getProject(ctx(fx.liveShareId, LIVE));
    const progress = await svc.getProgress(ctx(fx.liveShareId, LIVE));
    const docs = await svc.getDocuments(ctx(fx.liveShareId, LIVE));
    for (const surface of [project, progress, docs]) {
      const blob = JSON.stringify(surface);
      expect(blob).not.toContain(NID);
      expect(blob).not.toContain('national_id');
      expect(blob).not.toContain('nationalId');
      expect(blob).not.toContain(PHONE);
    }
  });

  it('the contractor view TYPE itself has no owner/national_id field (compile + runtime keys)', async () => {
    const view = await svc.getProject(ctx(fx.liveShareId, LIVE));
    // The permissions summary echoed to the FE only ever has these 3 booleans.
    expect(Object.keys(view.permissions).sort()).toEqual(['documents', 'overview', 'signatures']);
    // No apartment carries an owner/national_id field.
    for (const b of view.buildings) {
      for (const a of b.apartments) {
        expect(a).not.toHaveProperty('ownerId');
        expect(a).not.toHaveProperty('national_id');
        expect(a).not.toHaveProperty('owners');
      }
    }
  });
});
