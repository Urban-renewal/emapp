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
import { createHash, randomUUID } from 'crypto';
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
  documents,
  memberships,
  organizations,
  owners,
  ownerships,
  projects,
  signatureRequests,
  signatures,
  users,
} from '../src/schema/index';
import { withBootstrap } from '../src/wrappers/with-bootstrap';

import { uploadSeedDocBytes } from './seed-storage';

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

// === Documents (Alpha) ===
// 4 documents — covers both project-scope (regulation, blueprint) and
// apartment-scope (per-owner agreement). r2Key is deterministic so a re-
// run of the seed detects "already exists" via the UNIQUE index. The
// actual file bytes don't exist in storage — only metadata. Listing /
// counting / dashboard cards work; clicking Download would 404 (Fake
// provider has empty in-memory Map; the seed process is separate from
// the running API process). That's an accepted seed limitation; the
// "active system" feel comes from the workflow state, not from actually
// downloadable PDFs.
type SeedDoc = {
  key: string; // stable id within Alpha (used to build r2Key + cross-ref)
  name: string;
  type: string; // 'regulation' | 'blueprint' | 'agreement' | ...
  mimeType: string;
  sizeBytes: number;
  scope: 'project' | 'apt';
  aptNumber?: string; // for scope='apt'
};
const ALPHA_DOCUMENTS: SeedDoc[] = [
  {
    key: 'regulation',
    name: 'תקנון תמ"א 38 — אלפא.pdf',
    type: 'regulation',
    mimeType: 'application/pdf',
    sizeBytes: 248_910,
    scope: 'project',
  },
  {
    key: 'blueprint',
    name: 'תוכנית בנייה — חזית.pdf',
    type: 'blueprint',
    mimeType: 'application/pdf',
    sizeBytes: 1_245_312,
    scope: 'project',
  },
  {
    key: 'agreement-apt1',
    name: 'הסכם דייר — דירה 1.pdf',
    type: 'agreement',
    mimeType: 'application/pdf',
    sizeBytes: 156_872,
    scope: 'apt',
    aptNumber: '1',
  },
  {
    key: 'agreement-apt2',
    name: 'הסכם דייר — דירה 2.pdf',
    type: 'agreement',
    mimeType: 'application/pdf',
    sizeBytes: 162_004,
    scope: 'apt',
    aptNumber: '2',
  },
];

// === Signature requests (Alpha) ===
// Covers all 3 states (pending/signed/cancelled) across multiple owners
// + multiple documents — the dashboard should show realistic mixed
// activity. jti is the idempotency key (UNIQUE index in DB).
type SeedSigReq = {
  jti: string; // stable seed identifier
  docKey: string; // references ALPHA_DOCUMENTS[].key
  ownerIdx: number; // index into existing Alpha owners (createdAt-ordered)
  state: 'pending' | 'signed' | 'cancelled';
  daysAgo: number; // when the request was created (negative = future)
  signedDaysAgo?: number; // for signed
  cancelledDaysAgo?: number; // for cancelled
};
const ALPHA_SIG_REQS: SeedSigReq[] = [
  // Pending — manager invited Dana to sign her agreement; still waiting.
  {
    jti: 'seed-sig-apt1-dana-pending',
    docKey: 'agreement-apt1',
    ownerIdx: 0,
    state: 'pending',
    daysAgo: 1,
  },
  // Signed — Dana signed the apt-2 agreement (she's a 60% co-owner).
  {
    jti: 'seed-sig-apt2-dana-signed',
    docKey: 'agreement-apt2',
    ownerIdx: 0,
    state: 'signed',
    daysAgo: 4,
    signedDaysAgo: 2,
  },
  // Signed — Yossi signed the apt-2 agreement (his 40% half).
  {
    jti: 'seed-sig-apt2-yossi-signed',
    docKey: 'agreement-apt2',
    ownerIdx: 1,
    state: 'signed',
    daysAgo: 4,
    signedDaysAgo: 1,
  },
  // Pending — Yossi was invited on the project regulation; not signed yet.
  {
    jti: 'seed-sig-reg-yossi-pending',
    docKey: 'regulation',
    ownerIdx: 1,
    state: 'pending',
    daysAgo: 2,
  },
  // Cancelled — Sara was invited but the manager cancelled (wrong doc).
  {
    jti: 'seed-sig-reg-sara-cancelled',
    docKey: 'regulation',
    ownerIdx: 2,
    state: 'cancelled',
    daysAgo: 6,
    cancelledDaysAgo: 5,
  },
];

// Minimal SVG used as the signature blob for SIGNED requests. The FE
// renders signatures inline with <img src="data:image/svg+xml;..."> from
// the decoded bytes. This SVG draws a stylized signature stroke — not
// the owner's real handwriting (no fake credible signatures here).
const SIGNATURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60"><path d="M10 40 Q 30 10, 50 35 T 90 30 T 130 35 T 170 32 T 190 35" stroke="#1e3a8a" stroke-width="2.2" fill="none" stroke-linecap="round"/><text x="100" y="55" font-size="9" font-family="sans-serif" text-anchor="middle" fill="#64748b">חתימה דיגיטלית — תיעוד טסט</text></svg>`;

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
    phone: '+972521122334', // E.164 canonical (see OWNERS note — OTP lookup uses the normalized form)
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
    // E.164 canonical form — the production owner-create path normalizes via
    // `normalizeIsraeliPhone` before HMAC-hashing, and the tenant OTP lookup
    // hashes the SAME normalized form. A local "05..." literal here would hash
    // differently → the seeded resident could never receive an OTP. (login:
    // user types 0501234567; it normalizes to this.)
    phone: '+972501234567',
    email: 'dana@example.dev',
  },
  { name: 'יוסי לוי', nationalId: luhnId('99900022'), phone: '+972509876543' },
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
  await runDocuments(summary.orgId);
  await runSignatureWorkflow(summary.orgId);
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

async function runDocuments(orgId: string): Promise<void> {
  // Collected across the tx so we can upload renderable bytes AFTER commit
  // (the storage write is not part of the DB transaction). Includes both
  // newly-created docs and any already-existing seed docs, so re-running the
  // seed against a configured R2 backfills bytes for docs created by an
  // earlier (pre-this-fix) seed run.
  const docsForBytes: Array<{ r2Key: string; name: string }> = [];
  await withBootstrap(async (tx) => {
    // Resolve the Pilot project by NAME — NOT .limit(1). Smoke-test agents
    // create many projects under Alpha; picking "the first" picked a smoke
    // project at one point, attaching all seed documents to it (the
    // verification surfaced this — projectId pointed to 7db8ce03... instead
    // of c1ed4913...). Filtering by PROJECT_NAME is the stable identifier.
    const proj = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.name, PROJECT_NAME)))
      .limit(1);
    if (proj.length === 0) {
      console.log('[seed-dev/docs] Pilot project not found — skipping documents.');
      return;
    }
    const projectId = proj[0]!.id;

    // Corrective UPDATE: if seed-created documents (recognized by r2Key
    // prefix `documents/{orgId}/`) currently point to a different
    // projectId, fix them. Idempotent — sets only rows where projectId
    // differs from the now-correct Pilot id.
    const fixedProjectId = await tx
      .update(documents)
      .set({ projectId, updatedAt: new Date() })
      .where(
        and(
          eq(documents.orgId, orgId),
          sql`${documents.r2Key} LIKE ${`documents/${orgId}/%`}`,
          sql`${documents.projectId} <> ${projectId}`,
        ),
      )
      .returning({ id: documents.id });
    if (fixedProjectId.length > 0) {
      console.log(
        `[seed-dev/docs] corrected projectId on ${fixedProjectId.length} previously-misattributed documents.`,
      );
    }

    const mgr = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'manager@alpha.dev'))
      .limit(1);
    if (mgr.length === 0) return;
    const managerId = mgr[0]!.id;

    const aptRows = await tx
      .select({ id: apartments.id, number: apartments.number })
      .from(apartments)
      .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
      .innerJoin(projects, eq(projects.id, buildings.projectId))
      .where(eq(projects.orgId, orgId));
    const aptIdByNumber = new Map(aptRows.map((a) => [a.number, a.id]));

    let docsCreated = 0;
    for (const d of ALPHA_DOCUMENTS) {
      // r2Key is deterministic per (org, doc.key) → idempotent via the
      // UNIQUE index on documents.r2_key. We include orgId so re-seeding
      // a different org wouldn't collide.
      const r2Key = `documents/${orgId}/${d.key}.pdf`;
      // Every seed doc (new or pre-existing) is a byte-upload target so a
      // re-run against a configured R2 backfills bytes for docs an earlier
      // (pre-fix) seed created metadata-only.
      docsForBytes.push({ r2Key, name: d.name });
      const existing = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.r2Key, r2Key))
        .limit(1);
      if (existing.length > 0) continue;

      // contentHash is SHA-256 of a deterministic marker. In a real
      // upload this would be the hash of the actual file bytes; for
      // the seed we just need it stable + non-empty (the signatures
      // reference it via document_hash).
      const contentHash = createHash('sha256').update(`seed-${r2Key}`).digest('hex');
      const aptId =
        d.scope === 'apt' && d.aptNumber ? (aptIdByNumber.get(d.aptNumber) ?? null) : null;

      await tx.insert(documents).values({
        id: randomUUID(),
        orgId,
        projectId,
        apartmentId: aptId,
        name: d.name,
        type: d.type,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        r2Key,
        contentHash,
        uploadedBy: managerId,
      });
      docsCreated += 1;
    }
    if (docsCreated > 0) console.log(`[seed-dev/docs] created ${docsCreated} documents.`);
  });

  // Upload renderable PDF bytes AFTER the tx (storage is not transactional).
  // Real R2 → preview works in the running API. No R2 configured → skipped
  // (FakeStorage is per-process; the standalone seed can't reach the API's
  // in-memory store). Run the backfill script in that case, or seed with
  // Infisical R2_* present.
  const uploaded = await uploadSeedDocBytes(docsForBytes);
  if (docsForBytes.length > 0) {
    console.log(
      uploaded
        ? `[seed-dev/docs] uploaded renderable PDF bytes for ${docsForBytes.length} document(s) to R2.`
        : '[seed-dev/docs] R2 not configured — document bytes NOT uploaded (metadata only). ' +
            'Run `pnpm --filter @emapp/db backfill:doc-bytes` with Infisical to add renderable bytes.',
    );
  }
}

async function runSignatureWorkflow(orgId: string): Promise<void> {
  await withBootstrap(async (tx) => {
    const mgr = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'manager@alpha.dev'))
      .limit(1);
    if (mgr.length === 0) return;
    const managerId = mgr[0]!.id;

    // Owners in stable createdAt order — matches the indexing used by
    // runExtensions() for ownerships, so ownerIdx is consistent across
    // blocks (Dana=0, Yossi=1, Sara=2, plus the 4th unknown=3).
    const ownerRows = await tx
      .select({ id: owners.id })
      .from(owners)
      .where(eq(owners.orgId, orgId))
      .orderBy(owners.createdAt);
    if (ownerRows.length < 3) {
      console.log('[seed-dev/sigs] not enough owners — skipping signature workflow.');
      return;
    }

    // Map doc keys → document ids. We resolve by r2Key so the lookup is
    // immune to name changes (Hebrew renames don't break the join).
    const docKeyToId = new Map<string, { id: string; contentHash: string }>();
    for (const d of ALPHA_DOCUMENTS) {
      const r2Key = `documents/${orgId}/${d.key}.pdf`;
      const row = await tx
        .select({ id: documents.id, hash: documents.contentHash })
        .from(documents)
        .where(eq(documents.r2Key, r2Key))
        .limit(1);
      if (row.length > 0) docKeyToId.set(d.key, { id: row[0]!.id, contentHash: row[0]!.hash });
    }

    let reqsCreated = 0;
    let sigsCreated = 0;
    const now = Date.now();
    const dayMs = 86_400_000;
    const signatureBytes = Buffer.from(SIGNATURE_SVG, 'utf8');

    for (const r of ALPHA_SIG_REQS) {
      // Idempotency — jti is UNIQUE.
      const existing = await tx
        .select({ id: signatureRequests.id })
        .from(signatureRequests)
        .where(eq(signatureRequests.jti, r.jti))
        .limit(1);
      if (existing.length > 0) continue;

      const doc = docKeyToId.get(r.docKey);
      if (!doc) continue;
      const ownerId = ownerRows[r.ownerIdx]?.id;
      if (!ownerId) continue;

      const createdAt = new Date(now - r.daysAgo * dayMs);
      // Requests expire 14 days after creation (matches typical Phase 5
      // SIGNATURE_TOKEN_TTL_DAYS for the seed; the real link TTL is set
      // by env in production).
      const expiresAt = new Date(createdAt.getTime() + 14 * dayMs);

      let signedSignatureId: string | null = null;
      if (r.state === 'signed') {
        // Insert the corresponding signatures row first so we can link
        // signedSignatureId. signature_blob is raw SVG (D.12 — not
        // pgcrypto-encrypted; the at-rest protection comes from the
        // documents.contentHash anchor + the audit chain).
        const signedAt = new Date(now - (r.signedDaysAgo ?? 0) * dayMs);
        const signatureId = randomUUID();
        await tx.insert(signatures).values({
          id: signatureId,
          orgId,
          documentId: doc.id,
          ownerId,
          documentHash: doc.contentHash,
          signatureBlob: signatureBytes,
          signatureFormat: 'svg',
          signerIp: '203.0.113.42', // RFC 5737 TEST-NET-3 — never a real IP
          signerUserAgent:
            'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
          sessionId: null,
          authMethod: 'sms_otp',
          signedAt,
        });
        signedSignatureId = signatureId;
        sigsCreated += 1;
      }

      await tx.insert(signatureRequests).values({
        id: randomUUID(),
        orgId,
        documentId: doc.id,
        ownerId,
        jti: r.jti,
        status: r.state,
        expiresAt,
        createdBy: managerId,
        createdAt,
        signedAt: r.state === 'signed' ? new Date(now - (r.signedDaysAgo ?? 0) * dayMs) : null,
        signedSignatureId,
        cancelledAt:
          r.state === 'cancelled' ? new Date(now - (r.cancelledDaysAgo ?? 0) * dayMs) : null,
        cancelledBy: r.state === 'cancelled' ? managerId : null,
      });
      reqsCreated += 1;
    }

    if (reqsCreated > 0)
      console.log(
        `[seed-dev/sigs] created ${reqsCreated} signature requests (+${sigsCreated} signature rows).`,
      );
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
