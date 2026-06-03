/**
 * IAM Slice 1 — migration 0043 foundation: schema + RLS + seed + backfill.
 *
 * IAM-DESIGN §3/§4/§10. PURELY ADDITIVE — these tests assert the data model
 * exists, is RLS-protected, the 6 system roles are seeded with EXACTLY the §4
 * permission sets, and the backfill produced one assignment per active
 * membership + one per active agent project_assignment. They do NOT assert any
 * enforcement change (policy.ts is untouched).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../src/client';
import { roleAssignments, roles } from '../src/schema/iam';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

// The 6 system role keys and their EXACT permission sets are pinned here,
// independent of the application code, so a drift in EITHER the seed SQL or
// the code source-of-truth turns this red. (Mirror of IAM-DESIGN §4 / the
// generator in apps/api/src/common/authz/system-roles.ts.)
const ALL_PERMS = [
  'projects.read',
  'projects.create',
  'projects.update',
  'projects.archive',
  'buildings.read',
  'buildings.create',
  'buildings.update',
  'buildings.archive',
  'apartments.read',
  'apartments.create',
  'apartments.update',
  'apartments.archive',
  'owners.read',
  'owners.create',
  'owners.update',
  'owners.archive',
  'owners.reveal_pii',
  'ownerships.read',
  'ownerships.set',
  'documents.read',
  'documents.create',
  'documents.update',
  'documents.archive',
  'documents.download',
  'signature_requests.read',
  'signature_requests.send',
  'signature_requests.cancel',
  'tasks.read',
  'tasks.create',
  'tasks.update',
  'tasks.archive',
  'notes.read',
  'notes.create',
  'notes.update',
  'notes.archive',
  'contractors.read',
  'contractors.create',
  'contractors.update',
  'contractors.archive',
  'shares.create',
  'shares.revoke',
  'imports.read',
  'imports.run',
  'imports.cancel',
  'imports.map',
  'mapping_templates.read',
  'mapping_templates.manage',
  'export.run',
  'stats.read',
  'audit.read',
  'members.read',
  'members.invite',
  'members.update',
  'members.remove',
  'roles.read',
  'roles.assign',
  'roles.revoke',
  'roles.manage',
  'org.settings.read',
  'org.settings.update',
  'org.security_policy.manage',
  'org.billing.manage',
  'org.transfer_ownership',
  'org.delete',
];
const reads = ALL_PERMS.filter((p) => p.endsWith('.read'));
const gov = (p: string) =>
  p.startsWith('members.') || p.startsWith('roles.') || p.startsWith('org.');
const operational = ALL_PERMS.filter((p) => !gov(p));

const EXPECTED: Record<string, string[]> = {
  owner: [...ALL_PERMS],
  admin: [
    ...operational,
    'members.read',
    'members.invite',
    'members.update',
    'members.remove',
    'roles.read',
    'roles.assign',
    'roles.revoke',
    'roles.manage',
    'org.settings.read',
    'org.settings.update',
    'org.security_policy.manage',
  ],
  manager: [...operational],
  agent: operational.filter(
    (p) =>
      !['projects.create', 'owners.create', 'owners.reveal_pii', 'export.run'].includes(p) &&
      !p.startsWith('org.'),
  ),
  viewer: reads.filter((p) => p !== 'owners.reveal_pii'),
  external_read: [
    'projects.read',
    'buildings.read',
    'apartments.read',
    'documents.read',
    'documents.download',
    'signature_requests.read',
  ],
};

let orgA: TestOrg;
let orgB: TestOrg;

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`IAMA-${ts}`, `iama-${ts}`);
  orgB = await createTestOrg(`IAMB-${ts}`, `iamb-${ts}`);
});

afterAll(async () => {
  /* pool teardown handled globally */
});

async function pquery<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await providerPool.connect();
  try {
    const res = await client.query<T>(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}

describe('IAM 0043 · migration applied — tables + columns + RLS exist', () => {
  it('the 3 IAM tables exist', async () => {
    const rows = await pquery<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename IN ('roles','role_permissions','role_assignments')`,
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual([
      'role_assignments',
      'role_permissions',
      'roles',
    ]);
  });

  it('users gained external_id, idp, provisioning_source columns', async () => {
    const rows = await pquery<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
         WHERE table_name='users'
           AND column_name IN ('external_id','idp','provisioning_source')`,
    );
    const cols = rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(['external_id', 'idp', 'provisioning_source']);
    const ps = rows.find((r) => r.column_name === 'provisioning_source');
    expect(ps?.column_default ?? '').toContain('local');
  });

  it('RLS is ENABLED + FORCED on all 3 tables', async () => {
    const rows = await pquery<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname IN ('roles','role_permissions','role_assignments')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} rowsecurity`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} forcerowsecurity`).toBe(true);
    }
  });

  it('scope_type CHECK rejects an invalid scope', async () => {
    // Use a real seeded role + a real user/org so only the CHECK can fail.
    const roleId = (
      await pquery<{ id: string }>(`SELECT id FROM roles WHERE key='manager' AND org_id IS NULL`)
    )[0]!.id;
    let caught: unknown;
    try {
      await pquery(
        `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id)
           VALUES ($1,$2,'galaxy',$3)`,
        [orgA.users[0]!.id, roleId, orgA.id],
      );
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string })?.code).toBe('23514');
  });
});

describe('IAM 0043 · seed — 6 system roles with EXACTLY the §4 permission sets', () => {
  it('exactly the 6 system roles are seeded (org_id IS NULL, is_system)', async () => {
    const rows = await pquery<{ key: string }>(
      `SELECT key FROM roles WHERE org_id IS NULL AND is_system = true ORDER BY key`,
    );
    expect(rows.map((r) => r.key).sort()).toEqual([
      'admin',
      'agent',
      'external_read',
      'manager',
      'owner',
      'viewer',
    ]);
  });

  for (const key of Object.keys(EXPECTED)) {
    it(`role '${key}' has exactly its §4 permission set (${EXPECTED[key]!.length})`, async () => {
      const rows = await pquery<{ permission: string }>(
        `SELECT rp.permission FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
          WHERE r.key=$1 AND r.org_id IS NULL`,
        [key],
      );
      expect(rows.map((r) => r.permission).sort()).toEqual([...EXPECTED[key]!].sort());
    });
  }

  it('every seeded permission is a real catalog permission', async () => {
    const rows = await pquery<{ permission: string }>(
      `SELECT DISTINCT rp.permission FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id WHERE r.org_id IS NULL`,
    );
    const catalog = new Set(ALL_PERMS);
    for (const r of rows) expect(catalog.has(r.permission), r.permission).toBe(true);
  });
});

/**
 * The backfill ran ONCE at migration time over whatever data existed then. The
 * shared Neon DB has other suites concurrently inserting memberships, so a
 * GLOBAL count(memberships) vs count(assignments) comparison is inherently racy
 * (a membership created by another suite after the migration has no assignment
 * yet — by design). We therefore prove the backfill on a DEDICATED, fully-known
 * org: seed its memberships, run the exact 0043 backfill statement (idempotent),
 * then assert per-org equality + zero-missing. This is deterministic regardless
 * of concurrent writers.
 */
const ORG_BACKFILL_SQL = `
  INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_by, granted_at)
    SELECT m.user_id, r.id, 'org', m.org_id, m.invited_by, m.created_at
      FROM memberships m
      JOIN roles r ON r.org_id IS NULL AND r.is_system AND r.key = m.role::text
     WHERE m.revoked_at IS NULL
  ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`;

describe('IAM 0043 · backfill — assignments mirror memberships + project_assignments', () => {
  it('per-org: org-scoped assignment count == active membership count, each mapped to its same-named role', async () => {
    // Dedicated org with three known memberships (manager from the factory +
    // a fresh agent + a fresh viewer), each a distinct legacy role.
    const ts = Date.now();
    const org = await createTestOrg(`IAMBF-${ts}`, `iambf-${ts}`);
    for (const role of ['agent', 'viewer'] as const) {
      const u = await pquery<{ id: string }>(
        `INSERT INTO users (email, name) VALUES ($1,$2) RETURNING id`,
        [`iam-${role}-${ts}@test.local`, `IAM ${role}`],
      );
      await pquery(
        `INSERT INTO memberships (user_id, org_id, role, accepted_at) VALUES ($1,$2,$3, now())`,
        [u[0]!.id, org.id, role],
      );
    }

    // Run the exact backfill (idempotent) — picks up the newly-seeded rows.
    await pquery(ORG_BACKFILL_SQL);

    const mCount = (
      await pquery<{ c: string }>(
        `SELECT count(*)::text AS c FROM memberships WHERE org_id=$1 AND revoked_at IS NULL`,
        [org.id],
      )
    )[0]!.c;
    const aCount = (
      await pquery<{ c: string }>(
        `SELECT count(*)::text AS c FROM role_assignments WHERE scope_type='org' AND scope_id=$1`,
        [org.id],
      )
    )[0]!.c;
    expect(aCount).toBe(mCount);
    expect(mCount).toBe('3'); // manager + agent + viewer

    // Every active membership in THIS org has a same-named system-role assignment.
    const missing = await pquery<{ role: string }>(
      `SELECT m.role::text AS role FROM memberships m
        WHERE m.org_id=$1 AND m.revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM role_assignments ra
            JOIN roles r ON r.id = ra.role_id AND r.org_id IS NULL
           WHERE ra.user_id = m.user_id AND ra.scope_type='org'
             AND ra.scope_id = m.org_id AND r.key = m.role::text)`,
      [org.id],
    );
    expect(missing).toHaveLength(0);
  });

  it('each active agent project_assignment produced a project-scoped Agent assignment', async () => {
    // Create an agent + an active project_assignment, then re-run the backfill
    // segment idempotently to prove the mapping. We seed directly (BYPASSRLS).
    const agentRows = await pquery<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1,'IAM Agent') RETURNING id`,
      [`iam-agent-${Date.now()}@test.local`],
    );
    const agentUserId = agentRows[0]!.id;
    await pquery(
      `INSERT INTO memberships (user_id, org_id, role, accepted_at)
         VALUES ($1,$2,'agent', now())`,
      [agentUserId, orgA.id],
    );
    const projectId = orgA.projects[0]!.id;
    await pquery(
      `INSERT INTO project_assignments (project_id, user_id, assigned_by)
         VALUES ($1,$2,$3)`,
      [projectId, agentUserId, orgA.users[0]!.id],
    );

    // Re-run the two backfill INSERTs (idempotent — same statements as 0043).
    await pquery(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_by, granted_at)
         SELECT m.user_id, r.id, 'org', m.org_id, m.invited_by, m.created_at
           FROM memberships m
           JOIN roles r ON r.org_id IS NULL AND r.is_system AND r.key = m.role::text
          WHERE m.revoked_at IS NULL
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
    );
    await pquery(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_by, granted_at)
         SELECT pa.user_id, r.id, 'project', pa.project_id, pa.assigned_by, pa.assigned_at
           FROM project_assignments pa
           JOIN roles r ON r.org_id IS NULL AND r.is_system AND r.key='agent'
          WHERE pa.unassigned_at IS NULL
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
    );

    const rows = await pquery<{ id: string }>(
      `SELECT ra.id FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id AND r.org_id IS NULL AND r.key='agent'
        WHERE ra.user_id=$1 AND ra.scope_type='project' AND ra.scope_id=$2`,
      [agentUserId, projectId],
    );
    expect(rows).toHaveLength(1);
  });

  it('backfill is idempotent — re-running adds zero org assignments (scoped to orgA)', async () => {
    // Scope the count to orgA — no other suite mutates orgA's memberships, so
    // the before/after is race-free even on the shared DB.
    const countA = async (): Promise<string> =>
      (
        await pquery<{ c: string }>(
          `SELECT count(*)::text AS c FROM role_assignments WHERE scope_type='org' AND scope_id=$1`,
          [orgA.id],
        )
      )[0]!.c;
    const before = await countA();
    await pquery(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_by, granted_at)
         SELECT m.user_id, r.id, 'org', m.org_id, m.invited_by, m.created_at
           FROM memberships m
           JOIN roles r ON r.org_id IS NULL AND r.is_system AND r.key = m.role::text
          WHERE m.revoked_at IS NULL AND m.org_id=$1
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
      [orgA.id],
    );
    expect(await countA()).toBe(before);
  });
});

describe('IAM 0043 · RLS — tenant isolation + system-role cross-org read', () => {
  it('system roles are readable from any org (org_id IS NULL)', async () => {
    const fromA = await withTenant(orgA.id, async (tx) =>
      tx
        .select({ key: roles.key })
        .from(roles)
        .where(sql`org_id IS NULL`),
    );
    const fromB = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ key: roles.key })
        .from(roles)
        .where(sql`org_id IS NULL`),
    );
    expect(fromA.length).toBe(6);
    expect(fromB.length).toBe(6);
  });

  it("Org B cannot see Org A's org-scoped role_assignments", async () => {
    const fromB = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .where(sql`scope_type='org' AND scope_id = ${orgA.id}`),
    );
    expect(fromB).toHaveLength(0);
  });

  it('a custom role is tenant-isolated (Org A inserts, Org B cannot read)', async () => {
    const key = `custom-${Date.now()}`;
    await withTenant(orgA.id, async (tx) =>
      tx.insert(roles).values({ orgId: orgA.id, key, name: 'Custom', isSystem: false }),
    );
    const fromB = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ id: roles.id })
        .from(roles)
        .where(sql`key = ${key}`),
    );
    expect(fromB).toHaveLength(0);
  });

  it('app_user (via withTenant) cannot mutate a SYSTEM role (WITH CHECK denies org_id NULL)', async () => {
    let caught: unknown;
    try {
      await withTenant(orgA.id, async (tx) => {
        await tx.execute(
          sql`UPDATE roles SET name = 'hacked' WHERE key = 'owner' AND org_id IS NULL`,
        );
      });
    } catch (e) {
      caught = e;
    }
    // Either the UPDATE matches zero rows (USING lets it read but the row is
    // unchanged) or RLS rejects — assert the system role name is intact.
    void caught;
    const [row] = await pquery<{ name: string }>(
      `SELECT name FROM roles WHERE key='owner' AND org_id IS NULL`,
    );
    expect(row!.name).toBe('Owner');
  });
});
