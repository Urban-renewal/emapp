/**
 * Enterprise IAM — the SHADOW-EQUIVALENCE proof (IAM-DESIGN §6 / §10). Slice 3.
 *
 * The safety net for the cutover (§10 step 3): the new `PermissionService`
 * engine returns the SAME decision as the legacy `policy.ts` matrix for EVERY
 * (org-role × resource × action) cell — EXCEPT the cells we INTENTIONALLY change
 * (`KNOWN_DIVERGENCES`), which we assert diverge in the documented direction and
 * NOWHERE ELSE. An UNLISTED divergence = a real regression and fails CI.
 *
 * Real DB: the 6 system roles are seeded by migration 0043. For each legacy org
 * role (manager/agent/viewer → its system-role key, `LEGACY_ROLE_TO_SYSTEM_KEY`)
 * we assign that role at ORG scope and resolve through the engine, then compare
 * `engine.can(...)` to `policy.can(role,...)` cell-by-cell.
 *
 * ADDITIVE — nothing here changes behaviour. `policy.ts` stays the live enforcer;
 * the engine stays unwired. This spec is the only consumer of the equivalence map.
 */
import { randomUUID } from 'node:crypto';

import { db, users, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import {
  PermissionResolutionCache,
  PermissionService,
  type AuthzUser,
  type Scope,
} from './permission.service';
import { can, POLICY, type Action, type Resource, type Role } from './policy';
import {
  cellKey,
  KNOWN_DIVERGENCES,
  LEGACY_TO_PERMISSION,
  NO_ENGINE_EQUIVALENT,
  type DivergenceDirection,
} from './policy-equivalence.map';
import { LEGACY_ROLE_TO_SYSTEM_KEY, type SystemRoleKey } from './system-roles';

const LEGACY_ROLES: readonly Role[] = ['manager', 'agent', 'viewer'];
const ACTIONS: readonly Action[] = ['read', 'create', 'update', 'delete'];
const RESOURCES = Object.keys(POLICY) as Resource[];

let svc: PermissionService;
let org: TestOrg;
let orgScope: Scope;
/** One pre-assigned user id per legacy org role (assigned its system role @ org). */
const userByRole = new Map<Role, string>();

/** A fresh user (engine resolves purely from role_assignments — no membership row). */
async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `iam-equiv-${randomUUID()}@test.local`,
      name: 'IAM Equivalence User',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  return u!.id;
}

async function systemRoleId(key: SystemRoleKey): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM roles WHERE org_id IS NULL AND is_system = true AND key = $1`,
      [key],
    );
    if (!r.rows[0]) throw new Error(`system role not seeded: ${key}`);
    return r.rows[0].id;
  } finally {
    c.release();
  }
}

async function assignOrg(userId: string, key: SystemRoleKey, orgId: string): Promise<void> {
  const roleId = await systemRoleId(key);
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, 'org', $3, now())
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
      [userId, roleId, orgId],
    );
  } finally {
    c.release();
  }
}

function actor(id: string): AuthzUser {
  return { id, orgId: org.id };
}

/**
 * Index the documented divergences by (role, resource, action) so the proof can
 * ask, for any cell, "is this divergence expected, and in which direction?".
 */
const divergenceIndex = new Map<string, DivergenceDirection>();
for (const d of KNOWN_DIVERGENCES) {
  divergenceIndex.set(`${d.role}|${d.resource}|${d.action}`, d.direction);
}
function expectedDivergence(
  role: Role,
  resource: Resource,
  action: Action,
): DivergenceDirection | undefined {
  return divergenceIndex.get(`${role}|${resource}|${action}`);
}

const noEquivalentKeys = new Set(NO_ENGINE_EQUIVALENT.map((e) => e.key));

beforeAll(async () => {
  await setupTestDatabase();
  svc = new PermissionService();
  const tag = `iam-equiv-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  orgScope = { type: 'org', id: org.id };

  // Assign each legacy org role (as its mapped system role) to a user @ org scope.
  for (const role of LEGACY_ROLES) {
    const userId = await seedUser();
    await assignOrg(userId, LEGACY_ROLE_TO_SYSTEM_KEY[role], org.id);
    userByRole.set(role, userId);
  }
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ── Map integrity: every cell is accounted for, no overlaps, no orphans ──────
describe('equivalence map — structural integrity (no silent gap)', () => {
  it('every POLICY cell is EITHER mapped to a permission OR listed as no-equivalent (exactly one)', () => {
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        const key = cellKey(resource, action);
        const mapped = key in LEGACY_TO_PERMISSION;
        const noEquiv = noEquivalentKeys.has(key);
        expect(mapped || noEquiv, `${key} is neither mapped nor listed no-equivalent`).toBe(true);
        expect(mapped && noEquiv, `${key} is BOTH mapped and no-equivalent`).toBe(false);
      }
    }
  });

  it('NO_ENGINE_EQUIVALENT lists ONLY real POLICY cells (no stale entries)', () => {
    const valid = new Set<string>();
    for (const r of RESOURCES) for (const a of ACTIONS) valid.add(cellKey(r, a));
    for (const e of NO_ENGINE_EQUIVALENT) {
      expect(valid.has(e.key), `${e.key} is not a real POLICY cell`).toBe(true);
      expect(e.reason.length, `${e.key} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('every mapped permission targets EXACTLY one legacy cell key that exists in POLICY', () => {
    for (const key of Object.keys(LEGACY_TO_PERMISSION)) {
      const [resource, action] = key.split('.') as [Resource, Action];
      expect(POLICY[resource], `${key}: unknown resource`).toBeDefined();
      expect(POLICY[resource][action], `${key}: unknown action`).toBeDefined();
    }
  });

  it('every KNOWN_DIVERGENCE is a real, mapped cell with a reason (cannot diverge on an unmapped cell)', () => {
    for (const d of KNOWN_DIVERGENCES) {
      const key = cellKey(d.resource, d.action);
      expect(key in LEGACY_TO_PERMISSION, `divergence ${key} must be a mapped cell`).toBe(true);
      expect(LEGACY_TO_PERMISSION[key], `divergence ${key} permission mismatch`).toBe(d.permission);
      expect(d.reason.length, `divergence ${key} needs a reason`).toBeGreaterThan(0);
      expect(
        LEGACY_ROLES.includes(d.role),
        `divergence role ${d.role} must be a legacy org role`,
      ).toBe(true);
    }
  });

  it('no duplicate KNOWN_DIVERGENCE cell (each (role,resource,action) listed once)', () => {
    const seen = new Set<string>();
    for (const d of KNOWN_DIVERGENCES) {
      const k = `${d.role}|${d.resource}|${d.action}`;
      expect(seen.has(k), `duplicate divergence ${k}`).toBe(false);
      seen.add(k);
    }
  });
});

// ── The shadow-equivalence proof itself (real DB, engine vs policy.ts) ────────
describe('SHADOW EQUIVALENCE — engine.can(role) === policy.can(role), except KNOWN_DIVERGENCES', () => {
  for (const role of LEGACY_ROLES) {
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        const key = cellKey(resource, action);

        // Cells with no engine equivalent are proven elsewhere (the structural
        // test pins the no-equivalent SET) — skip them from the decision compare.
        if (noEquivalentKeys.has(key)) continue;

        const permission = LEGACY_TO_PERMISSION[key]!;
        const direction = expectedDivergence(role, resource, action);

        const label = direction
          ? `${role} ${key} → ${permission} : DIVERGES (${direction})`
          : `${role} ${key} → ${permission} : equal`;

        it(label, async () => {
          const userId = userByRole.get(role)!;
          const legacy = can(role, resource, action);
          const neu = await withTenant(org.id, async (tx) => {
            const cache = new PermissionResolutionCache();
            return svc.can(actor(userId), permission, orgScope, tx, cache);
          });

          if (!direction) {
            // The contract: identical decision. This is the safety net.
            expect(neu, `${role} ${key}: engine must match legacy`).toBe(legacy);
            return;
          }

          // A documented divergence: assert it actually diverges, AND in the
          // stated direction. 'new' = legacy DENY, engine ALLOW. 'legacy' =
          // legacy ALLOW, engine DENY.
          expect(neu, `${role} ${key}: documented divergence must actually differ`).not.toBe(
            legacy,
          );
          if (direction === 'new') {
            expect(legacy, `${role} ${key}: 'new' divergence expects legacy=false`).toBe(false);
            expect(neu, `${role} ${key}: 'new' divergence expects engine=true`).toBe(true);
          } else {
            expect(legacy, `${role} ${key}: 'legacy' divergence expects legacy=true`).toBe(true);
            expect(neu, `${role} ${key}: 'legacy' divergence expects engine=false`).toBe(false);
          }
        });
      }
    }
  }

  // The inverse guard: NO cell outside KNOWN_DIVERGENCES may differ. Computed in
  // one pass so a NEW silent mismatch (e.g. a future catalog edit) fails loudly,
  // independent of the per-cell `it`s above.
  it('NO undocumented divergence exists (every mismatch is in KNOWN_DIVERGENCES)', async () => {
    const undocumented: string[] = [];
    await withTenant(org.id, async (tx) => {
      for (const role of LEGACY_ROLES) {
        const userId = userByRole.get(role)!;
        const cache = new PermissionResolutionCache();
        for (const resource of RESOURCES) {
          for (const action of ACTIONS) {
            const key = cellKey(resource, action);
            if (noEquivalentKeys.has(key)) continue;
            const permission = LEGACY_TO_PERMISSION[key]!;
            const legacy = can(role, resource, action);
            const neu = await svc.can(actor(userId), permission, orgScope, tx, cache);
            const documented = expectedDivergence(role, resource, action) !== undefined;
            if (legacy !== neu && !documented) {
              undocumented.push(`${role} ${key} → ${permission}: legacy=${legacy} engine=${neu}`);
            }
            if (legacy === neu && documented) {
              undocumented.push(
                `${role} ${key} → ${permission}: listed as divergence but decisions MATCH (${legacy})`,
              );
            }
          }
        }
      }
    });
    expect(undocumented, `undocumented / stale divergences:\n${undocumented.join('\n')}`).toEqual(
      [],
    );
  });

  it('exactly the documented number of cells diverge (count pin)', async () => {
    let diverged = 0;
    let equal = 0;
    await withTenant(org.id, async (tx) => {
      for (const role of LEGACY_ROLES) {
        const userId = userByRole.get(role)!;
        const cache = new PermissionResolutionCache();
        for (const resource of RESOURCES) {
          for (const action of ACTIONS) {
            const key = cellKey(resource, action);
            if (noEquivalentKeys.has(key)) continue;
            const permission = LEGACY_TO_PERMISSION[key]!;
            const legacy = can(role, resource, action);
            const neu = await svc.can(actor(userId), permission, orgScope, tx, cache);
            if (legacy === neu) equal++;
            else diverged++;
          }
        }
      }
    });
    expect(diverged, 'diverged-cell count must equal KNOWN_DIVERGENCES.length').toBe(
      KNOWN_DIVERGENCES.length,
    );
    // Sanity: the overwhelming majority of cells are PROVEN EQUAL.
    expect(equal).toBeGreaterThan(diverged);
  });
});
