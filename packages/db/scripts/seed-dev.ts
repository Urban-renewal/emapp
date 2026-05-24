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
import { eq, sql } from 'drizzle-orm';

import { closeAllPools } from '../src/client';
import { env } from '../src/env';
import { encryptOwnerPii, type PiiFields } from '../src/helpers/owners';
import {
  apartments,
  buildings,
  memberships,
  organizations,
  owners,
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

// PII is FICTITIOUS — Israeli national IDs use a Luhn-like checksum;
// these are pure dev fixtures and do NOT collide with any real ID
// (the leading sequence keeps them out of the real-issuance space).
const OWNERS: Array<PiiFields & { email?: string }> = [
  { name: 'דנה כהן', nationalId: '999000111', phone: '0501234567', email: 'dana@example.dev' },
  { name: 'יוסי לוי', nationalId: '999000222', phone: '0509876543' },
  { name: 'שרה פרץ', nationalId: '999000333' },
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
    console.log(`[seed-dev] org "${ORG_SLUG}" already exists — nothing to do.`);
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
  return 0;
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
