/**
 * VOLUME seed (AUDIT TOOL — not a product path). Creates a SEPARATE org
 * `perf-load-dev` with realistic scale so the perf audit can measure heavy
 * screens: ~30 projects, ~3000 apartments, ~800 owners, ~500 signature
 * requests, ~100 documents, ownerships on the heavy building.
 *
 * Idempotent by slug. Chunked batch inserts (one Neon round-trip per chunk).
 * NOT for production (NODE_ENV guard). Reuses the real PII encryption helper.
 *
 * Run: infisical run --env=dev -- pnpm --filter @emapp/db exec tsx scripts/seed-volume.ts
 */
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import { hash as argon2Hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';

import { closeAllPools } from '../src/client';
import { env } from '../src/env';
import { encryptOwnerPiiBatch, type PiiFields } from '../src/helpers/owners';
import {
  apartments,
  buildings,
  documents,
  memberships,
  organizations,
  ownerships,
  owners,
  projects,
  signatureRequests,
  users,
} from '../src/schema/index';
import { withBootstrap } from '../src/wrappers/with-bootstrap';

const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const SLUG = 'perf-load-dev';
const N_PROJECTS = 30;
const BUILDINGS_PER_PROJECT = 2;
const HEAVY_BUILDING_APTS = 300;
const NORMAL_BUILDING_APTS = 46;
const N_OWNERS = 800;
const N_DOCS = 100;
const N_SIGREQS = 500;

function israeliCheckDigit(first8: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const d = Number(first8[i]);
    const p = d * ((i % 2) + 1);
    sum += p >= 10 ? Math.floor(p / 10) + (p % 10) : p;
  }
  return String((10 - (sum % 10)) % 10);
}

async function chunkedInsert<T>(tx: any, table: any, rows: T[], size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await tx.insert(table).values(rows.slice(i, i + size));
  }
}

async function main(): Promise<number> {
  if (env.NODE_ENV !== 'development') {
    console.error(`[seed-volume] NODE_ENV=${env.NODE_ENV} — refusing.`);
    return 1;
  }
  if (!env.PII_ENCRYPTION_KEY || !env.PII_HASH_KEY) {
    console.error('[seed-volume] PII keys missing — load via Infisical.');
    return 1;
  }
  const t0 = Date.now();
  const out = await withBootstrap(async (tx) => {
    const existing = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, SLUG))
      .limit(1);
    if (existing.length > 0) return { created: false, orgId: existing[0]!.id };

    const now = new Date();
    const orgId = randomUUID();
    await tx
      .insert(organizations)
      .values({
        id: orgId,
        name: 'Perf Load',
        slug: SLUG,
        plan: 'pilot',
        createdAt: now,
        updatedAt: now,
      });

    const managerId = randomUUID();
    const passwordHash = await argon2Hash('DevPassword123!', ARGON2);
    await tx
      .insert(users)
      .values({
        id: managerId,
        email: 'manager@perf-load.dev',
        name: 'מנהל עומס',
        passwordHash,
        avatarColor: '#0f766e',
        createdAt: now,
        updatedAt: now,
      });
    await tx
      .insert(memberships)
      .values({
        id: randomUUID(),
        userId: managerId,
        orgId,
        role: 'manager',
        isPrimary: true,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      });

    // Projects
    const projectRows = Array.from({ length: N_PROJECTS }, (_, i) => ({
      id: randomUUID(),
      orgId,
      name: `פרויקט עומס ${i + 1}`,
      type: (['tama38_1', 'tama38_2', 'pinui_binui'] as const)[i % 3],
      status: (['planning', 'gathering_signatures', 'approved'] as const)[i % 3],
      createdBy: managerId,
      createdAt: new Date(now.getTime() - i * 86400000),
      updatedAt: now,
    }));
    await chunkedInsert(tx, projects, projectRows);

    // Buildings + apartments
    const buildingRows: any[] = [];
    const apartmentRows: any[] = [];
    let heavyBuildingId = '';
    for (let p = 0; p < N_PROJECTS; p++) {
      for (let b = 0; b < BUILDINGS_PER_PROJECT; b++) {
        const bid = randomUUID();
        const isHeavy = p === 0 && b === 0;
        if (isHeavy) heavyBuildingId = bid;
        const aptN = isHeavy ? HEAVY_BUILDING_APTS : NORMAL_BUILDING_APTS;
        buildingRows.push({
          id: bid,
          projectId: projectRows[p]!.id,
          address: `רחוב ${p + 1}/${b + 1}`,
          city: 'תל אביב',
          aptCount: aptN,
          createdAt: now,
          updatedAt: now,
        });
        for (let a = 0; a < aptN; a++) {
          apartmentRows.push({
            id: randomUUID(),
            buildingId: bid,
            number: String(a + 1),
            status: 'pending',
            statusChangedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
    await chunkedInsert(tx, buildings, buildingRows);
    await chunkedInsert(tx, apartments, apartmentRows);

    // Owners (batch-encrypt PII)
    const piiInputs: PiiFields[] = Array.from({ length: N_OWNERS }, (_, i) => {
      const base = String(20000000 + i);
      return {
        name: `בעל דירה ${i + 1}`,
        nationalId: base + israeliCheckDigit(base),
        phone: `05${String(10000000 + i).slice(0, 8)}`,
      };
    });
    const enc = await encryptOwnerPiiBatch(tx, piiInputs);
    const ownerRows = enc.map((e, i) => ({
      id: randomUUID(),
      orgId,
      nameEncrypted: e.nameEncrypted,
      nameHash: e.nameHash,
      email: i % 3 === 0 ? `owner${i}@perf.dev` : null,
      nationalIdEncrypted: e.nationalIdEncrypted,
      nationalIdHash: e.nationalIdHash,
      phoneEncrypted: e.phoneEncrypted,
      phoneHash: e.phoneHash,
      createdAt: now,
      updatedAt: now,
    }));
    await chunkedInsert(tx, owners, ownerRows);

    // Ownerships on the heavy building's apartments (1 owner @100% each)
    const heavyApts = apartmentRows.filter((a) => a.buildingId === heavyBuildingId);
    const ownershipRows = heavyApts.map((a, i) => ({
      id: randomUUID(),
      apartmentId: a.id,
      ownerId: ownerRows[i % ownerRows.length]!.id,
      ownershipPct: '100',
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    await chunkedInsert(tx, ownerships, ownershipRows);

    // Documents
    const docRows = Array.from({ length: N_DOCS }, (_, i) => ({
      id: randomUUID(),
      orgId,
      projectId: projectRows[i % N_PROJECTS]!.id,
      apartmentId: apartmentRows[i]!.id,
      name: `מסמך ${i + 1}.pdf`,
      type: 'agreement',
      mimeType: 'application/pdf',
      sizeBytes: 100000 + i,
      r2Key: `perf/${orgId}/${randomUUID()}.pdf`,
      contentHash: randomUUID().replace(/-/g, ''),
      uploadedBy: managerId,
      createdAt: now,
      updatedAt: now,
    }));
    await chunkedInsert(tx, documents, docRows);

    // Signature requests (mixed status)
    const sigRows = Array.from({ length: N_SIGREQS }, (_, i) => ({
      id: randomUUID(),
      orgId,
      documentId: docRows[i % N_DOCS]!.id,
      ownerId: ownerRows[i % N_OWNERS]!.id,
      jti: randomUUID(),
      status: (['pending', 'signed', 'cancelled'] as const)[i % 3],
      expiresAt: new Date(now.getTime() + 14 * 86400000),
      createdBy: managerId,
      createdAt: new Date(now.getTime() - i * 3600000),
    }));
    await chunkedInsert(tx, signatureRequests, sigRows);

    return {
      created: true,
      orgId,
      projects: projectRows.length,
      buildings: buildingRows.length,
      apartments: apartmentRows.length,
      owners: ownerRows.length,
      docs: docRows.length,
      sigreqs: sigRows.length,
      heavyBuildingId,
    };
  });

  if (!out.created)
    console.log(`[seed-volume] org "${SLUG}" exists (${out.orgId}) — nothing to do.`);
  else
    console.log(
      `[seed-volume] created in ${((Date.now() - t0) / 1000).toFixed(1)}s:`,
      JSON.stringify(out),
    );
  return 0;
}

const isCli =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main()
    .then(async (c) => {
      await closeAllPools();
      process.exit(c);
    })
    .catch(async (e) => {
      console.error('[seed-volume] failed:', e);
      await closeAllPools();
      process.exit(1);
    });
}
export { main as runSeedVolume };
