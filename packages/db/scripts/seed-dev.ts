/**
 * Dev-seed for Phase 4a (FE work).
 *
 * Produces an idempotent baseline fixture so any FE developer can
 * `infisical run --env=dev -- pnpm --filter @emapp/db seed:dev` and
 * log in immediately as `manager@alpha.dev` / `DevPassword123!`.
 *
 * Fixtures (D.17 6-role / 3-tier matrix — Tier 1 only here):
 *   - org `Alpha` (slug `alpha-dev`)
 *   - 3 users — manager / agent / viewer (membership-accepted)
 *   - 1 project (`Tama 38/2 — Pilot`) status='gathering_signatures'
 *   - 2 buildings (under that project)
 *   - 4 apartments (2 per building, deterministic numbers)
 *   - 3 owners (PII-encrypted via the standard pgcrypto helpers —
 *     fictional Israeli IDs / phones; documented as fake)
 *
 * What we DO NOT seed:
 *   - ownerships — D.25 mandates atomic set-replace summing to exactly
 *     100; partial fixtures would either be invalid or commit-time-
 *     reject. Sum=0 (no rows) is the safe terminal state per D.25 and
 *     leaves S5 (Ownerships set-replace slice) to exercise the real
 *     wire flow without precondition collisions.
 *   - signatures / imports / documents — each gets its own slice.
 *
 * Idempotency: a re-run detects the org slug and short-circuits with a
 * status line. No destructive cleanup; legacy data is never touched.
 *
 * Safety:
 *   - Uses `withBootstrap` (RLS-bypass) — same primitive the auth
 *     signup path uses. The seed is a one-shot dev tool, not a runtime
 *     path; production won't load this script (no script entrypoint
 *     from any deployable).
 *   - argon2 params match `apps/api/src/modules/auth/password.ts`
 *     OWASP defaults — the password verifies identically against the
 *     real login flow.
 *   - PII helpers (`encryptOwnerPii`) require `PII_ENCRYPTION_KEY` +
 *     `PII_HASH_KEY` (Infisical dev) — the script fails loudly with a
 *     helpful message if missing.
 *
 * NOT for production. Guarded by a NODE_ENV !== 'development' check.
 */
/* eslint-disable no-console -- this script's job is to print fixture
 * info to the developer's stdout; the no-console rule that protects
 * application code does not apply to a dev tool. */
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';

import { hash as argon2Hash } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { closeAllPools } from '../src/client';
import { env } from '../src/env';
import { encryptOwnerPii, type PiiFields } from '../src/helpers/owners';
import {
  apartments,
  buildings,
  buildingSections,
  memberships,
  organizations,
  owners,
  ownerships,
  projects,
  users,
} from '../src/schema/index';
import { withBootstrap } from '../src/wrappers/with-bootstrap';

// OWASP Password Storage Cheat Sheet — must match apps/api password.ts.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const ORG_NAME = 'Alpha';
const ORG_SLUG = 'alpha-dev';
const ORG_PLAN = 'pilot';

const PASSWORD = 'DevPassword123!';
const USERS = [
  { email: 'manager@alpha.dev', name: 'מיכל מנהלת', role: 'manager' as const, avatar: '#0f766e' },
  { email: 'agent@alpha.dev', name: 'אבי סוכן', role: 'agent' as const, avatar: '#1d4ed8' },
  { email: 'viewer@alpha.dev', name: 'ויקי צופה', role: 'viewer' as const, avatar: '#a16207' },
];

const PROJECT_NAME = 'Tama 38/2 — Pilot';

const BUILDINGS = [
  { address: 'הרצל 10', city: 'תל אביב', aptNumbers: ['1', '2'] },
  { address: 'בן יהודה 25', city: 'תל אביב', aptNumbers: ['3', '4'] },
];

// Apartment metadata backfill — added after migration 0035 (D.39).
// Pre-existing seeds wrote apartments before unit_type/area_sqm/entrance
// existed; this backfill makes them look like apartments created via the
// post-D.39 wizard. Each apartment number is keyed to its metadata so a
// re-run of the seed only fills NULLs (doesn't overwrite anything).
const APT_META: Record<string, { unitType: string; areaSqm: string; entrance: string }> = {
  '1': { unitType: 'apt', areaSqm: '78.50', entrance: 'א' },
  '2': { unitType: 'apt', areaSqm: '82.00', entrance: 'א' },
  '3': { unitType: 'apt', areaSqm: '95.25', entrance: 'א' },
  '4': { unitType: 'office', areaSqm: '54.00', entrance: 'א' },
};

// One building_section per building — represents the typical single-entrance
// residential structure that most Tama 38 buildings have. Real-world multi-
// entrance buildings (פינוי-בינוי) will exercise the multi-section path; we
// keep the seed minimal (1 per building) per the "1-2 of each" rule.
const SECTIONS_PER_BUILDING = {
  entrance: 'א',
  kind: 'residential',
  floors: 4,
  unitCount: 2,
  gush: '6213',
  helka: '47',
};

// Ownerships — sum=100 per apartment (enforced by trigger from 0030).
// Mix of single-owner (100) and split (60/40) so the UI/exports can show
// both shapes. Keyed by apartment number; owner index references OWNERS.
const APT_OWNERSHIPS: Record<string, Array<{ ownerIdx: number; pct: string }>> = {
  '1': [{ ownerIdx: 0, pct: '100.00' }],
  '2': [
    { ownerIdx: 0, pct: '60.00' },
    { ownerIdx: 1, pct: '40.00' },
  ],
  '3': [{ ownerIdx: 1, pct: '100.00' }],
  '4': [{ ownerIdx: 2, pct: '100.00' }],
};

// Pending invite — manager has sent it; user hasn't accepted. This row
// exercises the "invite pending" UI state without needing a real email
// roundtrip. acceptedAt=null distinguishes from active members.
const PENDING_INVITE = {
  email: 'pending@alpha.dev',
  name: 'נועה ממתינה',
  role: 'agent' as const,
};

// Second org Beta — minimal bootstrap (manager-only) so cross-tenant
// smoke tests have a known foreign org to probe against. NEVER seed
// real customer-shaped data here; this exists for isolation testing.
const BETA = {
  name: 'Beta',
  slug: 'beta-dev',
  plan: 'pilot',
  manager: { email: 'manager@beta.dev', name: 'בני מנהל', avatar: '#7c3aed' },
  project: { name: 'פינוי-בינוי — קרית אונו (Beta)', type: 'pinui_binui' as const },
  building: { address: 'ויצמן 5', city: 'קרית אונו' },
  apartment: { number: '1', unitType: 'apt', areaSqm: '110.00', entrance: 'א' },
  owner: {
    name: 'רחל קטן',
    nationalId: luhnId('99900044'),
    phone: '0521122334',
  },
};

/**
 * Compute the Israeli national-ID check digit (closes §v9-M-2).
 * Spec: weights 1,2,1,2,1,2,1,2,1; if product ≥ 10, sum its digits;
 * check digit = (10 − (sum mod 10)) mod 10.
 *
 * Without this, the seed wrote IDs that PASSED the FE regex
 * (`/^\d{9}$/`) but would have FAILED the API DTO's MOD-10 refine,
 * so future API-side test fixtures regenerating these owners would
 * 400 with `validation_error`.
 */
function israeliCheckDigit(first8: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const d = Number(first8[i]);
    const w = (i % 2) + 1;
    const p = d * w;
    sum += p >= 10 ? Math.floor(p / 10) + (p % 10) : p;
  }
  return String((10 - (sum % 10)) % 10);
}
function luhnId(first8: string): string {
  if (!/^\d{8}$/.test(first8)) throw new Error(`luhnId: expected 8 digits, got ${first8}`);
  return first8 + israeliCheckDigit(first8);
}

// PII is FICTITIOUS — IDs pass the Israeli Luhn checksum so future
// API-DTO smoke tests that recreate these owners via the real BE
// path are not rejected with validation_error.
const OWNERS: Array<PiiFields & { email?: string }> = [
  {
    name: 'דנה כהן',
    nationalId: luhnId('99900011'),
    phone: '0501234567',
    email: 'dana@example.dev',
  },
  { name: 'יוסי לוי', nationalId: luhnId('99900022'), phone: '0509876543' },
  { name: 'שרה פרץ', nationalId: luhnId('99900033') },
];

async function main(): Promise<number> {
  if (env.NODE_ENV !== 'development') {
    console.error(`[seed-dev] NODE_ENV=${env.NODE_ENV} — refusing to run outside development.`);
    return 1;
  }
  if (!env.PII_ENCRYPTION_KEY || !env.PII_HASH_KEY) {
    console.error('[seed-dev] PII_ENCRYPTION_KEY / PII_HASH_KEY missing — load via Infisical.');
    return 1;
  }

  const summary = await withBootstrap(async (tx) => {
    // Idempotency: detect existing seed by slug.
    const existing = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, ORG_SLUG))
      .limit(1);

    if (existing.length > 0) {
      return { created: false, orgId: existing[0]!.id };
    }

    const passwordHash = await argon2Hash(PASSWORD, ARGON2);
    const orgId = randomUUID();
    const now = new Date();

    await tx.insert(organizations).values({
      id: orgId,
      name: ORG_NAME,
      slug: ORG_SLUG,
      plan: ORG_PLAN,
      createdAt: now,
      updatedAt: now,
    });

    // Users + memberships
    const userIds: Record<string, string> = {};
    for (const u of USERS) {
      const userId = randomUUID();
      userIds[u.role] = userId;
      await tx.insert(users).values({
        id: userId,
        email: u.email,
        name: u.name,
        passwordHash,
        avatarColor: u.avatar,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(memberships).values({
        id: randomUUID(),
        userId,
        orgId,
        role: u.role,
        isPrimary: u.role === 'manager',
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Project
    const projectId = randomUUID();
    await tx.insert(projects).values({
      id: projectId,
      orgId,
      name: PROJECT_NAME,
      type: 'tama38_2',
      status: 'gathering_signatures',
      description: 'Dev pilot project for FE work.',
      createdBy: userIds['manager']!,
      createdAt: now,
      updatedAt: now,
    });

    // Buildings + apartments
    let apartmentsCreated = 0;
    for (const b of BUILDINGS) {
      const buildingId = randomUUID();
      await tx.insert(buildings).values({
        id: buildingId,
        projectId,
        address: b.address,
        city: b.city,
        aptCount: b.aptNumbers.length,
        createdAt: now,
        updatedAt: now,
      });
      for (const num of b.aptNumbers) {
        await tx.insert(apartments).values({
          id: randomUUID(),
          buildingId,
          number: num,
          status: 'pending',
          statusChangedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        apartmentsCreated += 1;
      }
    }

    // Owners — PII encryption via the standard helper. We CANNOT use
    // `encryptOwnerPiiBatch` here because that uses jsonb_array_elements
    // with implicit ordering — fine in normal API paths, but for a
    // small fixed fixture the simple loop is plenty fast and the call
    // site reads like the production owner-create path.
    let ownersCreated = 0;
    for (const o of OWNERS) {
      const enc = await encryptOwnerPii(tx, {
        nationalId: o.nationalId,
        phone: o.phone,
        name: o.name,
      });
      await tx.insert(owners).values({
        id: randomUUID(),
        orgId,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        email: o.email ?? null,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
        createdAt: now,
        updatedAt: now,
      });
      ownersCreated += 1;
    }

    // Reset the sequence-less audit_log columns are server-defaulted,
    // so nothing else to do — the trigger writes happen on real writes.
    void sql; // keep `sql` import warm; useful for follow-up migrations.

    return {
      created: true,
      orgId,
      userIds,
      apartmentsCreated,
      ownersCreated,
    };
  });

  if (!summary.created) {
    console.log(`[seed-dev] org "${ORG_SLUG}" already exists — checking extensions.`);
  } else {
    console.log(`[seed-dev] created org "${ORG_SLUG}" (${summary.orgId}).`);
    console.log('[seed-dev] users:');
    for (const u of USERS) {
      console.log(`  - ${u.role.padEnd(7)}  ${u.email}  /  password: ${PASSWORD}`);
    }
    console.log(
      `[seed-dev] +1 project, ${BUILDINGS.length} buildings, ${summary.apartmentsCreated} apartments, ${summary.ownersCreated} owners.`,
    );
  }

  // Extensions — each block is idempotent (skip if data already present).
  // We run them AFTER the baseline, regardless of whether Alpha was just
  // bootstrapped or pre-existed, so an older seed gets brought up to date.
  await runExtensions(summary.orgId);
  await bootstrapBeta();

  return 0;
}

async function runExtensions(orgId: string): Promise<void> {
  await withBootstrap(async (tx) => {
    // Resolve the manager userId — needed for createdBy on any new
    // entities (and to attribute the pending invite to a real inviter).
    const managerRow = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'manager@alpha.dev'))
      .limit(1);
    if (managerRow.length === 0) {
      console.log('[seed-dev/ext] manager@alpha.dev not found — skipping extensions.');
      return;
    }
    const managerId = managerRow[0]!.id;

    // === A. Backfill apartment metadata (unit_type/area_sqm/entrance) ===
    // Only sets columns where area_sqm is NULL (proxy for "not backfilled").
    let metaUpdated = 0;
    const aptRows = await tx
      .select({ id: apartments.id, number: apartments.number, areaSqm: apartments.areaSqm })
      .from(apartments)
      .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
      .innerJoin(projects, eq(projects.id, buildings.projectId))
      .where(and(eq(projects.orgId, orgId), isNull(apartments.areaSqm)));
    for (const apt of aptRows) {
      const meta = APT_META[apt.number];
      if (!meta) continue;
      await tx
        .update(apartments)
        .set({ unitType: meta.unitType, areaSqm: meta.areaSqm, entrance: meta.entrance })
        .where(eq(apartments.id, apt.id));
      metaUpdated += 1;
    }
    if (metaUpdated > 0)
      console.log(`[seed-dev/ext] backfilled metadata on ${metaUpdated} apartments.`);

    // === B. building_sections (1 per Alpha building) ===
    // Skip per-building if that building already has any non-archived section.
    let sectionsCreated = 0;
    const bldRows = await tx
      .select({ id: buildings.id })
      .from(buildings)
      .innerJoin(projects, eq(projects.id, buildings.projectId))
      .where(eq(projects.orgId, orgId));
    for (const b of bldRows) {
      const existing = await tx
        .select({ id: buildingSections.id })
        .from(buildingSections)
        .where(and(eq(buildingSections.buildingId, b.id), isNull(buildingSections.archivedAt)))
        .limit(1);
      if (existing.length > 0) continue;
      await tx.insert(buildingSections).values({
        id: randomUUID(),
        buildingId: b.id,
        entrance: SECTIONS_PER_BUILDING.entrance,
        kind: SECTIONS_PER_BUILDING.kind,
        floors: SECTIONS_PER_BUILDING.floors,
        unitCount: SECTIONS_PER_BUILDING.unitCount,
        gush: SECTIONS_PER_BUILDING.gush,
        helka: SECTIONS_PER_BUILDING.helka,
      });
      sectionsCreated += 1;
    }
    if (sectionsCreated > 0)
      console.log(`[seed-dev/ext] created ${sectionsCreated} building_sections.`);

    // === C. Ownerships (sum=100 enforced by 0030 trigger) ===
    // Skip per-apartment if any active ownership row already exists.
    // We resolve OWNERS by nationalIdHash (the only stable index — names
    // are encrypted, IDs are deterministic from luhnId).
    let ownershipsCreated = 0;
    let ownershipsSkipped = 0;
    // We don't try to map by national_id_hash — PII_HASH_KEY rotation
    // would silently invalidate the lookup. For seed fixtures, the
    // semantic "apartment N is owned by owner index K" is good enough
    // when the owners exist in any order. Take stable-ordered owner ids.
    const ownerRows = await tx
      .select({ id: owners.id, createdAt: owners.createdAt })
      .from(owners)
      .where(eq(owners.orgId, orgId))
      .orderBy(owners.createdAt);
    const ownerIdByIdx: string[] = ownerRows.map((r) => r.id);

    const aptForOwnership = await tx
      .select({ id: apartments.id, number: apartments.number })
      .from(apartments)
      .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
      .innerJoin(projects, eq(projects.id, buildings.projectId))
      .where(eq(projects.orgId, orgId));
    for (const apt of aptForOwnership) {
      const existing = await tx
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(and(eq(ownerships.apartmentId, apt.id), isNull(ownerships.endedAt)))
        .limit(1);
      if (existing.length > 0) {
        ownershipsSkipped += 1;
        continue;
      }
      const spec = APT_OWNERSHIPS[apt.number];
      if (!spec) continue;
      for (const row of spec) {
        const ownerId = ownerIdByIdx[row.ownerIdx];
        if (!ownerId) continue;
        await tx.insert(ownerships).values({
          id: randomUUID(),
          apartmentId: apt.id,
          ownerId,
          ownershipPct: row.pct,
        });
        ownershipsCreated += 1;
      }
    }
    if (ownershipsCreated > 0)
      console.log(`[seed-dev/ext] created ${ownershipsCreated} ownerships (sum=100 per apt).`);
    else if (ownershipsSkipped > 0)
      console.log(
        `[seed-dev/ext] ${ownershipsSkipped} apartments already had ownerships — skipped.`,
      );
    else
      console.log(
        `[seed-dev/ext] WARN: 0 ownerships created and 0 skipped — check owner-id resolution (${ownerRows.length} owners found, ${ownerIdByIdx.length} matched).`,
      );

    // === D. Pending invite (membership with acceptedAt=null) ===
    // Skip if a user with that email already exists. The pending row
    // represents "manager has invited; user hasn't clicked the link yet."
    const existingInvitee = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, PENDING_INVITE.email))
      .limit(1);
    if (existingInvitee.length === 0) {
      const inviteeId = randomUUID();
      // Pending invites have no password yet — set a placeholder that
      // CANNOT verify (argon2 rejects malformed hashes). The real user
      // will set their password via /accept-invite which UPDATEs the row.
      await tx.insert(users).values({
        id: inviteeId,
        email: PENDING_INVITE.email,
        name: PENDING_INVITE.name,
        passwordHash: 'invite-pending',
        avatarColor: '#9333ea',
      });
      await tx.insert(memberships).values({
        id: randomUUID(),
        userId: inviteeId,
        orgId,
        role: PENDING_INVITE.role,
        isPrimary: false,
        acceptedAt: null,
        invitedBy: managerId,
      });
      console.log(`[seed-dev/ext] created pending invite for ${PENDING_INVITE.email}.`);
    }
  });
}

async function bootstrapBeta(): Promise<void> {
  await withBootstrap(async (tx) => {
    const existing = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, BETA.slug))
      .limit(1);
    if (existing.length > 0) {
      // Beta exists; nothing to do (we don't run extensions on it).
      return;
    }

    const orgId = randomUUID();
    const managerId = randomUUID();
    const projectId = randomUUID();
    const buildingId = randomUUID();
    const sectionId = randomUUID();
    const apartmentId = randomUUID();
    const ownerId = randomUUID();
    const passwordHash = await argon2Hash(PASSWORD, ARGON2);

    await tx.insert(organizations).values({
      id: orgId,
      name: BETA.name,
      slug: BETA.slug,
      plan: BETA.plan,
    });
    await tx.insert(users).values({
      id: managerId,
      email: BETA.manager.email,
      name: BETA.manager.name,
      passwordHash,
      avatarColor: BETA.manager.avatar,
    });
    await tx.insert(memberships).values({
      id: randomUUID(),
      userId: managerId,
      orgId,
      role: 'manager',
      isPrimary: true,
      acceptedAt: new Date(),
    });
    await tx.insert(projects).values({
      id: projectId,
      orgId,
      name: BETA.project.name,
      type: BETA.project.type,
      status: 'planning',
      description: 'Beta org fixture for cross-tenant smoke.',
      createdBy: managerId,
    });
    await tx.insert(buildings).values({
      id: buildingId,
      projectId,
      address: BETA.building.address,
      city: BETA.building.city,
      aptCount: 1,
    });
    await tx.insert(buildingSections).values({
      id: sectionId,
      buildingId,
      entrance: 'א',
      kind: 'residential',
      floors: 3,
      unitCount: 1,
      gush: '7811',
      helka: '92',
    });
    await tx.insert(apartments).values({
      id: apartmentId,
      buildingId,
      number: BETA.apartment.number,
      status: 'pending',
      statusChangedAt: new Date(),
      unitType: BETA.apartment.unitType,
      areaSqm: BETA.apartment.areaSqm,
      entrance: BETA.apartment.entrance,
    });
    const ownerEnc = await encryptOwnerPii(tx, BETA.owner);
    await tx.insert(owners).values({
      id: ownerId,
      orgId,
      nameEncrypted: ownerEnc.nameEncrypted,
      nameHash: ownerEnc.nameHash,
      nationalIdEncrypted: ownerEnc.nationalIdEncrypted,
      nationalIdHash: ownerEnc.nationalIdHash,
      phoneEncrypted: ownerEnc.phoneEncrypted,
      phoneHash: ownerEnc.phoneHash,
    });
    await tx.insert(ownerships).values({
      id: randomUUID(),
      apartmentId,
      ownerId,
      ownershipPct: '100.00',
    });

    console.log(`[seed-dev/beta] created org "${BETA.slug}" (${orgId}).`);
    console.log(`[seed-dev/beta]   user: ${BETA.manager.email}  /  password: ${PASSWORD}`);
    console.log(
      `[seed-dev/beta]   +1 project, 1 building (+1 section), 1 apartment, 1 owner, 1 ownership (100%).`,
    );
  });
}

const isCli =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main()
    .then(async (code) => {
      await closeAllPools();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('[seed-dev] failed:', err);
      await closeAllPools();
      process.exit(1);
    });
}

export { main as runSeedDev };
