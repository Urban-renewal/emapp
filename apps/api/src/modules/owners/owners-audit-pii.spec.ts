/**
 * v8.5 HIGH (Audit SOLID #7 — concrete bug): owners.create writes an
 * audit_log row. Pre-v8.5 that row carried `afterState: { name }`
 * containing the cleartext Hebrew name, defeating §v8-S3
 * encryption-at-rest of `owners.name`.
 *
 * v8.5 fix: parity with update() — afterState carries `{ changed: [...] }`
 * (field NAMES, not values). The row itself still has the cleartext
 * available via the encrypted column + GUC; audit_log just enumerates
 * what changed.
 *
 * These tests pin the contract:
 *   1. afterState.name field DOES NOT exist (no key by that name)
 *   2. afterState.changed contains 'name' (so audit forensics can still
 *      reconstruct "this audit row was about a name change")
 *   3. afterState contains NO national_id value, NO phone value, NO
 *      email value (the regression class is "what other PII did this
 *      reach for?")
 *   4. The owner row IS created and queryable (the fix must not have
 *      broken the happy path)
 */
import { randomUUID } from 'node:crypto';

import { auditLog, organizations, owners, providerDb, users, withTenant } from '@emapp/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnersService } from './owners.service';

const TEST_PREFIX = 'v85-owner-audit';

let orgId: string;
let userId: string;
let svc: OwnersService;

const TEST_SID = '00000000-0000-4000-8000-00000000beef';

function user(): AccessTokenPayload {
  return {
    sub: userId,
    orgId,
    role: 'manager',
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedOrgAndUser(): Promise<{ orgId: string; userId: string }> {
  const oid = randomUUID();
  const uid = randomUUID();
  await providerDb.insert(organizations).values({
    id: oid,
    name: `${TEST_PREFIX}-${oid.slice(0, 8)}`,
    slug: `${TEST_PREFIX}-${oid.slice(0, 8)}`.replace(/[^a-z0-9-]/gi, '').slice(0, 30),
  });
  await providerDb.insert(users).values({
    id: uid,
    email: `${TEST_PREFIX}-${uid.slice(0, 8)}@test.local`,
    passwordHash: 'argon2id$dummy',
    name: 'v8.5 audit test',
  });
  return { orgId: oid, userId: uid };
}

async function cleanup(): Promise<void> {
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(users)
    .where(eq(users.id, userId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
}

describe('v8.5 owners.create — audit_log.afterState carries no cleartext PII', () => {
  beforeAll(async () => {
    ({ orgId, userId } = await seedOrgAndUser());
    svc = new OwnersService();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('1) afterState DOES NOT contain a `name` key (no cleartext name leak)', async () => {
    const NAME = 'אבי שמיר-לוי';
    const created = await svc.create(user(), {
      name: NAME,
      national_id: '038123456',
    } as never);

    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id)))
        .orderBy(auditLog.createdAt),
    );
    expect(row).toBeDefined();
    const afterState = row!.afterState as Record<string, unknown>;
    // Negative invariant: the regression we closed.
    expect(afterState).not.toHaveProperty('name');
    // And the actual value MUST NOT appear anywhere in the blob.
    expect(JSON.stringify(afterState)).not.toContain(NAME);
  });

  it('2) afterState.changed contains "name" (audit forensics can still know name was set)', async () => {
    const created = await svc.create(user(), {
      name: 'בלהה רבינוביץ',
      national_id: '038123457',
    } as never);
    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const after = row!.afterState as { changed?: unknown };
    expect(Array.isArray(after.changed)).toBe(true);
    expect(after.changed).toContain('name');
    expect(after.changed).toContain('national_id');
  });

  it('3) afterState.changed includes phone ONLY when phone was provided', async () => {
    const withPhone = await svc.create(user(), {
      name: 'עם טלפון',
      national_id: '038123458',
      phone: '0541234567',
    } as never);
    const withoutPhone = await svc.create(user(), {
      name: 'בלי טלפון',
      national_id: '038123459',
    } as never);

    const rows = await withTenant(orgId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.targetTable, 'owners')),
    );
    const a = rows.find((r) => r.targetId === withPhone.id);
    const b = rows.find((r) => r.targetId === withoutPhone.id);
    expect((a!.afterState as { changed: string[] }).changed).toContain('phone');
    expect((b!.afterState as { changed: string[] }).changed).not.toContain('phone');
  });

  it('4) afterState contains NO national_id value (the worst-case PII leak class)', async () => {
    const NID = '038111222';
    const created = await svc.create(user(), {
      name: 'בדיקת תעודת זהות',
      national_id: NID,
    } as never);
    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const blob = JSON.stringify(row!.afterState);
    expect(blob).not.toContain(NID);
    expect(blob).not.toMatch(/038111222/); // belt + braces
  });

  it('5) afterState contains NO phone value (5xx-leading 9-digit substring)', async () => {
    const PHONE = '0541112233';
    const created = await svc.create(user(), {
      name: 'בדיקת טלפון באודיט',
      national_id: '038123460',
      phone: PHONE,
    } as never);
    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const blob = JSON.stringify(row!.afterState);
    expect(blob).not.toContain(PHONE);
    // Also the normalised E.164 form — if a future normalise change
    // started writing the +972 form into audit, that's a regression.
    expect(blob).not.toMatch(/\+9725/);
  });

  it('6) afterState contains NO email value', async () => {
    const EMAIL = 'private-email-do-not-leak@example.test';
    const created = await svc.create(user(), {
      name: 'אימייל פרטי',
      national_id: '038123461',
      email: EMAIL,
    } as never);
    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    const blob = JSON.stringify(row!.afterState);
    expect(blob).not.toContain(EMAIL);
    expect(blob).not.toContain('private-email-do-not-leak');
  });

  it('7) the owner row IS created with the cleartext available via encrypted column (the fix did not break the happy path)', async () => {
    const NAME = 'הנתיב המאושר';
    const created = await svc.create(user(), {
      name: NAME,
      national_id: '038123462',
    } as never);
    // Direct read with BYPASSRLS to confirm the row is there + has
    // an encrypted name. We don't decrypt here — owner-name-encryption
    // spec pins the round-trip; here we just confirm the row exists.
    const [row] = await providerDb
      .select({ id: owners.id, nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.id, created.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.nameEncrypted).toBeInstanceOf(Buffer);
    expect((row!.nameEncrypted as Buffer).length).toBeGreaterThan(0);
  });

  it('8) audit row carries actor_id and actor_type=user (Manager-credited, not system)', async () => {
    const created = await svc.create(user(), {
      name: 'מי כתב את האודיט',
      national_id: '038123463',
    } as never);
    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetTable, 'owners'), eq(auditLog.targetId, created.id))),
    );
    expect(row!.actorType).toBe('user');
    expect(row!.actorId).toBe(userId);
    expect(row!.action).toBe('owner.create');
  });
});
