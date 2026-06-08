/**
 * P6-1 — per-org settings READ/WRITE surface (`/api/v1/org/settings`).
 * Adversarial, real-DB proof. Written by the TEST-AUTHOR agent — independent of
 * the builder; the builder's claims are NOT trusted.
 *
 * The surface has three load-bearing layers, each proven against a real Neon
 * row (no drizzle/tx mocking — a hand-mocked chain would only re-assert the
 * mock's own return value and hide the wiring):
 *
 *   • SERVICE (`OrgSettingsService`) — the only WRITE path. We drive it directly
 *     with a hand-built `AccessTokenPayload` (the same pattern the owners /
 *     audit-pii specs use) and assert against the actual `organizations.settings`
 *     jsonb (read BYPASS-of-merge via withTenant) and the actual `audit_log` row.
 *
 *   • AUTHZ (`PermissionService`) — the 403/200 gate. The controller's
 *     `AuthorizationGuard` literally calls
 *     `permissions.can(actor, '<perm>', {type:'org', id:orgId}, tx, cache)`;
 *     we seed REAL `role_assignments` for Owner / Admin / Manager / Viewer /
 *     Agent / no-assignment and resolve through the same engine — so a 403 here
 *     is the exact decision the endpoint returns. This is the faithful proof of
 *     the guard's verdict without standing up Fastify.
 *
 *   • WRITE-VALIDATION (`OrgSettingsPatchSchema` via the controller's exact
 *     `ZodValidationPipe` instance) — the 400 on an unknown key / out-of-bounds
 *     value. We run the SAME pipe the controller constructs, asserting it throws
 *     `BadRequestException`, i.e. the endpoint's 400.
 *
 * Items 1-8 map to the brief. Tests 3 (authz), 4 (no-clobber), 7 (cross-org),
 * 8 (no-PII) are the adversarial headline; test 4 is mutation-proven in-place
 * (a blind `set({settings: patch})` would wipe the sibling namespace → the
 * assertion would fail; documented at the assertion).
 */
import { randomUUID } from 'node:crypto';

import { auditLog, organizations, withTenant } from '@emapp/db';
import {
  DEFAULT_ORG_SETTINGS,
  OrgSettingsPatchSchema,
  resolveOrgSettings,
  type OrgSettingsPatch,
} from '@emapp/shared-types';
import { BadRequestException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import {
  PermissionResolutionCache,
  PermissionService,
  type AuthzUser,
  type Scope,
} from '../../common/authz/permission.service';
import type { SystemRoleKey } from '../../common/authz/system-roles';
import { getOrgSettings } from '../../common/org-settings.resolver';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OrgSettingsService } from './org-settings.service';

let svc: OrgSettingsService;
let perms: PermissionService;
let orgA: TestOrg;
let orgB: TestOrg;

const SID = '00000000-0000-4000-8000-0000000000c1';

/** A hand-built access payload for `orgA`'s manager-membership user. The
 *  SERVICE never consults authz (the guard does) — it only needs a valid
 *  (userId, orgId) so withTenant/audit attribute correctly. */
function payload(orgId: string, userId: string): AccessTokenPayload {
  return {
    sub: userId,
    orgId,
    role: 'manager',
    sid: SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** Overwrite `organizations.settings` for an org (RLS-scoped via withTenant) —
 *  the seam's raw write path, used to plant a known STORED jsonb before a GET
 *  or to reset between cases. */
async function setStored(orgId: string, value: unknown): Promise<void> {
  await withTenant(orgId, async (tx) => {
    await tx
      .update(organizations)
      .set({ settings: value as Record<string, unknown> })
      .where(eq(organizations.id, orgId));
  });
}

/** Read the RAW stored jsonb (NOT resolved) for an org — to prove what was
 *  actually persisted (vs. what the resolver fills in). BYPASSRLS so the read
 *  is unfiltered by the merge/resolve path. */
async function rawStored(orgId: string): Promise<Record<string, unknown>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM organizations WHERE id = $1`,
      [orgId],
    );
    return r.rows[0]!.settings;
  } finally {
    c.release();
  }
}

// ── AUTHZ seeding (faithful to the guard) ──────────────────────────────────
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

async function seedUserWithRole(key: SystemRoleKey, orgId: string): Promise<string> {
  const userId = randomUUID();
  const roleId = await systemRoleId(key);
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO users (id, email, name, password_hash)
       VALUES ($1, $2, 'authz probe', '$2b$12$placeholder')`,
      [userId, `org-settings-authz-${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, 'org', $3, now())
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
      [userId, roleId, orgId],
    );
  } finally {
    c.release();
  }
  return userId;
}

/** A bare user with NO role_assignment at all (default-deny). */
async function seedUserNoRole(): Promise<string> {
  const userId = randomUUID();
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO users (id, email, name, password_hash)
       VALUES ($1, $2, 'no role', '$2b$12$placeholder')`,
      [userId, `org-settings-norole-${userId}@test.local`],
    );
  } finally {
    c.release();
  }
  return userId;
}

function actor(id: string, orgId: string): AuthzUser {
  return { id, orgId };
}

/** Resolve a permission decision the EXACT way the AuthorizationGuard does. */
async function can(
  userId: string,
  orgId: string,
  permission: 'org.settings.read' | 'org.settings.update',
): Promise<boolean> {
  const scope: Scope = { type: 'org', id: orgId };
  return withTenant(orgId, async (tx) => {
    const cache = new PermissionResolutionCache();
    return perms.can(actor(userId, orgId), permission, scope, tx, cache);
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new OrgSettingsService();
  perms = new PermissionService();
  const tag = `p6-org-settings-${Date.now()}`;
  orgA = await createTestOrg(tag, tag);
  orgB = await createTestOrg(`${tag}-b`, `${tag}-b`);
}, 120_000);

afterAll(async () => {
  // Reset both orgs' settings so we don't leak custom config into another suite.
  await setStored(orgA.id, {}).catch(() => undefined);
  await setStored(orgB.id, {}).catch(() => undefined);
});

// ════════════════════════════════════════════════════════════════════════
// Item 1 — READ resolves: empty → full defaults; partial → defaults + overrides
// ════════════════════════════════════════════════════════════════════════
describe('item 1 — GET resolves over defaults', () => {
  it('empty/`{}` stored settings → GET returns the FULL DEFAULT_ORG_SETTINGS', async () => {
    await setStored(orgA.id, {});
    const got = await svc.get(payload(orgA.id, orgA.users[0]!.id));
    expect(got).toEqual(DEFAULT_ORG_SETTINGS);
    // concrete leaves, not deep-equal-to-itself:
    expect(got.locale).toBe('he');
    expect(got.notifications.defaultChannels).toEqual(['in_app']);
    expect(got.signatures.linkTtlDays).toBe(7);
    expect(got.limits.bulkCap).toBe(200);
  });

  it('a PARTIAL stored value → GET returns defaults + stored overrides merged', async () => {
    await setStored(orgA.id, {
      locale: 'en',
      signatures: { linkTtlDays: 30 },
    });
    const got = await svc.get(payload(orgA.id, orgA.users[0]!.id));
    // overrides honored:
    expect(got.locale).toBe('en');
    expect(got.signatures.linkTtlDays).toBe(30);
    // untouched leaves/namespaces filled from defaults:
    expect(got.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    expect(got.limits.bulkCap).toBe(200);
    expect(got.notifications.defaultChannels).toEqual(['in_app']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Item 2 — WRITE persists + resolver reflects it
// ════════════════════════════════════════════════════════════════════════
describe('item 2 — PATCH persists; GET + getOrgSettings reflect the new value', () => {
  it('PATCH notifications.defaultChannels → jsonb updated; later GET + resolver see it', async () => {
    await setStored(orgA.id, {});
    const result = await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      notifications: { defaultChannels: ['in_app', 'email'] },
    });
    // (a) the returned (re-resolved) tree reflects the patch:
    expect(result.notifications.defaultChannels).toEqual(['in_app', 'email']);

    // (b) the RAW jsonb was actually written (not just resolved in memory):
    const raw = await rawStored(orgA.id);
    expect((raw['notifications'] as Record<string, unknown>)['defaultChannels']).toEqual([
      'in_app',
      'email',
    ]);

    // (c) a SUBSEQUENT GET reflects it:
    const got = await svc.get(payload(orgA.id, orgA.users[0]!.id));
    expect(got.notifications.defaultChannels).toEqual(['in_app', 'email']);

    // (d) the notifications-engine read path (`getOrgSettings`) reflects it too —
    //     this is what the engine actually consumes at fan-out time.
    const viaResolver = await withTenant(orgA.id, (tx) => getOrgSettings(tx, orgA.id));
    expect(viaResolver.notifications.defaultChannels).toEqual(['in_app', 'email']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Item 3 — AUTHZ (the headline): only org.settings.update holders may write;
//          only org.settings.read holders may read. Driven through the SAME
//          engine the AuthorizationGuard calls, over REAL seeded assignments.
// ════════════════════════════════════════════════════════════════════════
describe('item 3 — authz: update is Owner/Admin only; Manager/Viewer/Agent denied', () => {
  it('UPDATE: Owner + Admin hold it; Manager + Viewer + Agent + no-role do NOT (the 403)', async () => {
    const owner = await seedUserWithRole('owner', orgA.id);
    const admin = await seedUserWithRole('admin', orgA.id);
    const manager = await seedUserWithRole('manager', orgA.id);
    const viewer = await seedUserWithRole('viewer', orgA.id);
    const agent = await seedUserWithRole('agent', orgA.id);
    const none = await seedUserNoRole();

    // Holders → the guard would allow (endpoint 200):
    expect(await can(owner, orgA.id, 'org.settings.update'), 'owner update').toBe(true);
    expect(await can(admin, orgA.id, 'org.settings.update'), 'admin update').toBe(true);

    // Non-holders → the guard would 403. Manager is the D.17 "full" role yet is
    // intentionally NOT an org-settings writer (org.* is governance, excluded
    // from ALL_OPERATIONAL) — this is the precise, enforced contract.
    expect(await can(manager, orgA.id, 'org.settings.update'), 'MANAGER must NOT write').toBe(
      false,
    );
    expect(await can(viewer, orgA.id, 'org.settings.update'), 'VIEWER must NOT write').toBe(false);
    expect(await can(agent, orgA.id, 'org.settings.update'), 'AGENT must NOT write').toBe(false);
    expect(await can(none, orgA.id, 'org.settings.update'), 'no-role must NOT write').toBe(false);
  }, 60_000); // 6 seeded users × several serial Neon round-trips each

  it('READ: Owner + Admin hold org.settings.read; Viewer + Agent do NOT (governance read)', async () => {
    const owner = await seedUserWithRole('owner', orgA.id);
    const admin = await seedUserWithRole('admin', orgA.id);
    const viewer = await seedUserWithRole('viewer', orgA.id);
    const agent = await seedUserWithRole('agent', orgA.id);

    expect(await can(owner, orgA.id, 'org.settings.read'), 'owner read').toBe(true);
    expect(await can(admin, orgA.id, 'org.settings.read'), 'admin read').toBe(true);
    // Viewer/Agent are excluded from org.* reads (least-privilege; system-roles).
    expect(await can(viewer, orgA.id, 'org.settings.read'), 'VIEWER must NOT read').toBe(false);
    expect(await can(agent, orgA.id, 'org.settings.read'), 'AGENT must NOT read').toBe(false);
  }, 60_000);

  it('NON-VACUOUS: the same Manager who is DENIED settings IS granted an operational write', async () => {
    // Proves the deny is a real least-privilege boundary, not a misconfigured
    // user who can do nothing. The Manager holds `projects.update` but not
    // `org.settings.update`.
    const manager = await seedUserWithRole('manager', orgA.id);
    expect(await can(manager, orgA.id, 'org.settings.update')).toBe(false);
    const operational = await withTenant(orgA.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      return perms.can(
        actor(manager, orgA.id),
        'projects.update',
        { type: 'org', id: orgA.id },
        tx,
        cache,
      );
    });
    expect(operational, 'manager should still hold an operational write').toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Item 4 — DEEP-MERGE does NOT clobber siblings (LOAD-BEARING, mutation-proven)
// ════════════════════════════════════════════════════════════════════════
describe('item 4 — PATCH of namespace B preserves stored namespace A', () => {
  it('stored {signatures, notifications}; PATCH only notifications → signatures PRESERVED', async () => {
    // Plant TWO overridden namespaces in the stored jsonb.
    await setStored(orgA.id, {
      signatures: { linkTtlDays: 21, channels: ['email'] }, // namespace A (overridden)
      notifications: { defaultChannels: ['in_app'] }, // namespace B (will be patched)
    });

    // PATCH touches ONLY namespace B.
    const result = await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      notifications: { defaultChannels: ['in_app', 'email', 'sms'] },
    });

    // B reflects the patch:
    expect(result.notifications.defaultChannels).toEqual(['in_app', 'email', 'sms']);

    // A's STORED override is PRESERVED — NOT reset to the default (7 / all-channels).
    // MUTATION INTUITION: a blind `set({ settings: patch })` overwrite would drop
    // `signatures` entirely; the resolver would then fill it from defaults and
    // `linkTtlDays` would read 7 / channels ['sms','email','whatsapp'] →
    // BOTH assertions below would FAIL. They pass only because the service deep-
    // merges the patch over the stored value.
    expect(result.signatures.linkTtlDays, 'sibling namespace A clobbered (linkTtlDays)').toBe(21);
    expect(result.signatures.channels, 'sibling namespace A clobbered (channels)').toEqual([
      'email',
    ]);

    // And the RAW jsonb still carries the un-touched namespace A verbatim:
    const raw = await rawStored(orgA.id);
    expect((raw['signatures'] as Record<string, unknown>)['linkTtlDays']).toBe(21);
    expect((raw['signatures'] as Record<string, unknown>)['channels']).toEqual(['email']);
    // B written:
    expect((raw['notifications'] as Record<string, unknown>)['defaultChannels']).toEqual([
      'in_app',
      'email',
      'sms',
    ]);
  });

  it('within ONE namespace, an untouched LEAF survives a sibling-leaf patch', async () => {
    // signatures has BOTH leaves overridden; patch only linkTtlDays → channels
    // override must survive (shallow-merge inside the namespace, not replace).
    await setStored(orgA.id, {
      signatures: { linkTtlDays: 10, channels: ['email', 'whatsapp'] },
    });
    const result = await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      signatures: { linkTtlDays: 45 },
    } as OrgSettingsPatch);
    expect(result.signatures.linkTtlDays).toBe(45); // patched leaf
    expect(result.signatures.channels).toEqual(['email', 'whatsapp']); // untouched leaf preserved
    const raw = await rawStored(orgA.id);
    expect((raw['signatures'] as Record<string, unknown>)['channels']).toEqual([
      'email',
      'whatsapp',
    ]);
  });

  it('SCHEMA-LEVEL: parsing { signatures: { linkTtlDays: 30 } } injects NO `channels` (no-default-injection)', () => {
    // The DB round-trip above preserves the stored `channels` sibling ONLY
    // because the patch is a TRUE partial: an absent leaf stays ABSENT after
    // parse (no baked default injected), so the service spread can't reset it.
    // Pin that contract at the SCHEMA level so a regression to a default-
    // injecting partial (e.g. a re-introduced `.deepPartial()`) is caught even
    // without the DB. The parsed namespace is EXACTLY { linkTtlDays: 30 }.
    const parsed = OrgSettingsPatchSchema.parse({ signatures: { linkTtlDays: 30 } }) as {
      signatures: Record<string, unknown>;
    };
    expect(parsed).toEqual({ signatures: { linkTtlDays: 30 } });
    expect(parsed.signatures).not.toHaveProperty('channels');
    expect(Object.keys(parsed.signatures)).toEqual(['linkTtlDays']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Item 5 — Absent → default survives: a namespace NOT in the stored jsonb still
//          resolves to its default after a partial PATCH (merge is over RAW).
// ════════════════════════════════════════════════════════════════════════
describe('item 5 — a namespace absent from stored jsonb still resolves to default', () => {
  it('after PATCHing only notifications, the RAW jsonb omits `limits`, yet GET resolves limits to default', async () => {
    await setStored(orgA.id, {});
    await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      notifications: { defaultChannels: ['email'] },
    });

    // RAW jsonb contains ONLY the patched namespace — `limits` is absent (the
    // merge persists only what was overridden, never the whole resolved tree).
    const raw = await rawStored(orgA.id);
    expect(raw).toHaveProperty('notifications');
    expect(raw, 'limits must NOT be materialised into stored jsonb').not.toHaveProperty('limits');
    expect(raw, 'consent must NOT be materialised into stored jsonb').not.toHaveProperty('consent');

    // …but the next GET still resolves the absent namespace to its default.
    const got = await svc.get(payload(orgA.id, orgA.users[0]!.id));
    expect(got.limits.bulkCap).toBe(200);
    expect(got.limits.defaultPageSize).toBe(25);
    expect(got.consent.tama38_1).toBe(66);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Item 6 — Unknown-key / out-of-bounds rejected (the endpoint's 400). Driven
//          through the controller's EXACT ZodValidationPipe instance.
// ════════════════════════════════════════════════════════════════════════
describe('item 6 — PATCH validation rejects unknown keys + out-of-bounds values (400)', () => {
  const pipe = new ZodValidationPipe(OrgSettingsPatchSchema);

  it('a typo`d TOP-LEVEL namespace (`notificatons`) → BadRequest (strict)', () => {
    expect(() => pipe.transform({ notificatons: { defaultChannels: ['in_app'] } })).toThrow(
      BadRequestException,
    );
  });

  // A stray leaf INSIDE a known namespace is a 400 (NOT silently stripped). The
  // patch is derived from the read schema with each namespace `.strict()`
  // reapplied, so `{ branding: { color } }` / `{ signatures: { foo } }` is
  // rejected exactly like a typo'd top-level namespace — the write path stays
  // strict so the stored jsonb can never accumulate junk leaves.
  it('a stray leaf inside a known namespace (`branding.color`) → BadRequest (nested strict)', () => {
    expect(() => pipe.transform({ branding: { color: '#fff' } })).toThrow(BadRequestException);
  });

  it('a stray leaf inside `signatures` (`foo`) → BadRequest (nested strict)', () => {
    expect(() => pipe.transform({ signatures: { foo: 1 } })).toThrow(BadRequestException);
  });

  it('out-of-bounds signatures.linkTtlDays (999 > .max(90)) → BadRequest', () => {
    expect(() => pipe.transform({ signatures: { linkTtlDays: 999 } })).toThrow(BadRequestException);
  });

  it('out-of-bounds limits.bulkCap (0 < .min(1)) → BadRequest', () => {
    expect(() => pipe.transform({ limits: { bulkCap: 0 } })).toThrow(BadRequestException);
  });

  it('a malformed branding.emailFrom (not an email) → BadRequest', () => {
    expect(() => pipe.transform({ branding: { emailFrom: 'not-an-email' } })).toThrow(
      BadRequestException,
    );
  });

  it('a WELL-FORMED partial patch passes the pipe (negative control — not always-throws)', () => {
    const out = pipe.transform({ notifications: { defaultChannels: ['in_app', 'email'] } }) as {
      notifications: { defaultChannels: string[] };
    };
    expect(out.notifications.defaultChannels).toEqual(['in_app', 'email']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Item 7 — Cross-org isolation: a holder in orgA only ever mutates orgA.
// ════════════════════════════════════════════════════════════════════════
describe('item 7 — PATCH in orgA never mutates orgB', () => {
  it('orgA PATCH leaves orgB.settings UNCHANGED', async () => {
    // Plant a KNOWN sentinel in orgB and snapshot it.
    await setStored(orgB.id, { locale: 'ar', limits: { bulkCap: 333 } });
    const beforeB = await rawStored(orgB.id);

    // A holder in orgA writes a distinct value.
    await setStored(orgA.id, {});
    await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      locale: 'en',
      limits: { bulkCap: 777 },
    } as OrgSettingsPatch);

    // orgB is byte-for-byte unchanged.
    const afterB = await rawStored(orgB.id);
    expect(afterB).toEqual(beforeB);
    expect((afterB['limits'] as Record<string, unknown>)['bulkCap']).toBe(333);
    expect(afterB['locale']).toBe('ar');

    // …and orgA got exactly its own write (sanity that the write landed somewhere).
    const rawA = await rawStored(orgA.id);
    expect(rawA['locale']).toBe('en');
    expect((rawA['limits'] as Record<string, unknown>)['bulkCap']).toBe(777);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Item 8 — Audit no-PII: the audit row's afterState carries only namespace
//          NAMES, never the values (esp. branding.emailFrom / senderName).
// ════════════════════════════════════════════════════════════════════════
describe('item 8 — org.settings.update audit row carries names only, never values', () => {
  it('PATCHing branding (sender identity) audits {changed:["branding"]} with NO emailFrom/senderName value', async () => {
    await setStored(orgA.id, {});
    const SECRET_FROM = 'do-not-leak-sender@private.example';
    const SECRET_NAME = 'Sekret Sender Display Name';

    await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      branding: { emailFrom: SECRET_FROM, senderName: SECRET_NAME },
    });

    // DESC + [0] → the row this test JUST wrote (earlier items also wrote
    // `org.settings.update` rows on orgA; we want the latest).
    const [row] = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'org.settings.update'), eq(auditLog.targetId, orgA.id)))
        .orderBy(desc(auditLog.createdAt)),
    );
    expect(row, 'no audit row written for the settings update').toBeDefined();

    // (a) attribution is real:
    expect(row!.actorType).toBe('user');
    expect(row!.actorId).toBe(orgA.users[0]!.id);
    expect(row!.targetTable).toBe('organizations');

    // (b) afterState is NAMES ONLY:
    const after = row!.afterState as { changed?: unknown };
    expect(Array.isArray(after.changed)).toBe(true);
    expect(after.changed).toEqual(['branding']);

    // (c) the worst-case PII leak class: NO sender value anywhere in the blob.
    const blob = JSON.stringify(row!.afterState);
    expect(blob, 'audit leaked the org from-address').not.toContain(SECRET_FROM);
    expect(blob, 'audit leaked the org sender display name').not.toContain(SECRET_NAME);
    expect(blob).not.toContain('private.example');
  });

  it('a multi-namespace PATCH records BOTH namespace names (and still no values)', async () => {
    await setStored(orgA.id, {});
    await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      locale: 'en',
      notifications: { defaultChannels: ['email'] },
    });
    const [latest] = await withTenant(orgA.id, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'org.settings.update'), eq(auditLog.targetId, orgA.id)))
        .orderBy(desc(auditLog.createdAt)),
    );
    const changed = (latest!.afterState as { changed: string[] }).changed;
    expect(new Set(changed)).toEqual(new Set(['locale', 'notifications']));
    // no channel value name leaks beyond the namespace key:
    const blob = JSON.stringify(latest!.afterState);
    expect(blob).not.toContain('defaultChannels');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Cross-check: the service's deep-merge result is consistent with the pure
// resolver fed the SAME merged jsonb (no second merge implementation drifts).
// ════════════════════════════════════════════════════════════════════════
describe('consistency — service result equals resolveOrgSettings(raw stored)', () => {
  it('after any PATCH, GET == resolveOrgSettings(rawStored)', async () => {
    await setStored(orgA.id, { signatures: { linkTtlDays: 12 } });
    await svc.update(payload(orgA.id, orgA.users[0]!.id), {
      notifications: { defaultChannels: ['in_app', 'sms'] },
    });
    const got = await svc.get(payload(orgA.id, orgA.users[0]!.id));
    const raw = await rawStored(orgA.id);
    expect(got).toEqual(resolveOrgSettings(raw));
    // and both honour the two distinct namespaces:
    expect(got.signatures.linkTtlDays).toBe(12);
    expect(got.notifications.defaultChannels).toEqual(['in_app', 'sms']);
  });
});
