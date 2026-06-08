/**
 * P4 — Resident self-update of their OWN contact (EMAIL only).
 * Adversarial real-DB proof for `PortalService.updateContact` +
 * `PortalUpdateContactSchema`. Real Neon, same harness as portal.s4.
 *
 * Load-bearing (do NOT make vacuous):
 *   • Test 2 (own-row) — the `owners` RLS policy is ORG-scoped, NOT
 *     own-row, so the own-record guarantee is an APPLICATION-layer WHERE
 *     (`id = tenant.sub`). The contract has no id; identity is the JWT
 *     `sub`. We prove ownerA's update CANNOT touch ownerB (no id to pass)
 *     and that forging a different sub only ever hits THAT sub's own row.
 *   • Test 6 (no PII) — the audit row's afterState is EXACTLY
 *     `{ changed: ['email'] }`; the email VALUE + national_id + phone are
 *     absent from the whole audit/log path.
 *
 * No JWT verification here — the guard is unit-tested in
 * tenant-auth.guard.spec.ts; we feed the resolved payload directly,
 * mirroring portal.s4.spec.ts (no `eyJ...` literal anywhere).
 */
import { auditLog, encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { PortalUpdateContactSchema } from '@emapp/shared-types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { TenantTokenPayload } from '../auth/tenant/tenant-auth.guard';

import { PortalService } from './portal.service';

const svc = new PortalService();

let orgA: TestOrg;

const fx = {
  ownerAId: '',
  ownerBId: '',
  archivedOwnerId: '',
  ownerANationalId: '305111111',
  ownerAPhone: '0521111111',
  ownerBNationalId: '305222222',
  ownerBPhone: '0522222222',
};

function tenantOf(o: TestOrg, ownerId: string): TenantTokenPayload {
  return {
    sub: ownerId,
    orgId: o.id,
    role: 'tenant',
    type: 'tenant_access',
    sid: '00000000-0000-0000-0000-000000000000',
  };
}

async function makeOwner(
  o: TestOrg,
  args: {
    name: string;
    nationalId: string;
    phone: string;
    email?: string | null;
    archived?: boolean;
  },
): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as unknown as Parameters<typeof encryptOwnerPii>[0], {
      name: args.name,
      nationalId: args.nationalId,
      phone: args.phone,
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: o.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
        email: args.email ?? null,
        archivedAt: args.archived ? new Date() : null,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Read the raw `email` column for an owner, RLS-scoped. */
async function rawEmail(o: TestOrg, ownerId: string): Promise<string | null> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .select({ email: owners.email })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    return row?.email ?? null;
  });
}

/** Decrypt national_id + phone in-SQL (proves the PII columns are untouched
 *  by updateContact — same pgcrypto path the service uses for masking). */
async function decryptPii(
  o: TestOrg,
  ownerId: string,
): Promise<{ nationalId: string; phone: string | null }> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .select({
        nationalId: sql<string>`pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text`,
        phone: sql<
          string | null
        >`case when ${owners.phoneEncrypted} is null then null else pgp_sym_decrypt(${owners.phoneEncrypted}, current_setting('app.encryption_key'))::text end`,
      })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    return { nationalId: row!.nationalId, phone: row!.phone };
  });
}

const NO_CTX = { ip: '9.9.9.9', userAgent: 'p4-spec' };

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`P4A-${ts}`, `p4a-${ts}`);

  fx.ownerAId = await makeOwner(orgA, {
    name: 'אבי תנעמי',
    nationalId: fx.ownerANationalId,
    phone: fx.ownerAPhone,
    email: 'old-a@example.com',
  });
  fx.ownerBId = await makeOwner(orgA, {
    name: 'בני כהן',
    nationalId: fx.ownerBNationalId,
    phone: fx.ownerBPhone,
    email: 'b-untouched@example.com',
  });
  fx.archivedOwnerId = await makeOwner(orgA, {
    name: 'גנוז',
    nationalId: '305333333',
    phone: '0523333333',
    email: 'archived@example.com',
    archived: true,
  });
}, 60_000);

afterAll(async () => {
  void providerPool;
});

describe('P4 · PortalService.updateContact — resident self-update contact (email-only)', () => {
  // ── 1) own-record happy path ────────────────────────────────────────
  it('1) ownerA updates own email → 200; DB row + masked me reflect it', async () => {
    const res = await svc.updateContact(
      tenantOf(orgA, fx.ownerAId),
      { email: 'new-a@example.com' },
      NO_CTX,
    );
    // masked-me envelope reflects the new value...
    expect(res.data.id).toBe(fx.ownerAId);
    expect(res.data.email).toBe('new-a@example.com');
    // national_id/phone stay MASKED in the response (D.47).
    expect(res.data.nationalIdMasked).toBe('•••••••11');
    expect(res.data.phoneMasked).toBe('•••••1111');
    // ...and so does the underlying DB column.
    expect(await rawEmail(orgA, fx.ownerAId)).toBe('new-a@example.com');
  });

  // ── 2) THE HEADLINE — cannot touch another owner (application-layer) ─
  it('2) ownerA update NEVER mutates ownerB — own-row is the WHERE, not RLS', async () => {
    const before = await rawEmail(orgA, fx.ownerBId);
    expect(before).toBe('b-untouched@example.com');

    // ownerA drives the update. The contract has NO id field — identity is
    // tenant.sub. There is no parameter through which ownerA could even
    // NAME ownerB's row.
    await svc.updateContact(tenantOf(orgA, fx.ownerAId), { email: 'a-again@example.com' }, NO_CTX);

    // ownerB is UNCHANGED. (If the service WHERE were weakened to org-only
    // — `eq(owners.orgId, …)` instead of `eq(owners.id, tenant.sub)` — this
    // org-wide overwrite would set ownerB.email too and THIS assertion fails.
    // That is the mutation proof: own-row is enforced application-side.)
    expect(await rawEmail(orgA, fx.ownerBId)).toBe('b-untouched@example.com');

    // Positive half of the proof: identity === sub. Forge a payload whose
    // sub IS ownerB and confirm the update lands on ownerB's OWN row only
    // (never ownerA), i.e. `sub` is the entire scope.
    await svc.updateContact(tenantOf(orgA, fx.ownerBId), { email: 'b-self@example.com' }, NO_CTX);
    expect(await rawEmail(orgA, fx.ownerBId)).toBe('b-self@example.com');
    // ownerA was not collaterally changed by ownerB's self-update.
    expect(await rawEmail(orgA, fx.ownerAId)).toBe('a-again@example.com');
  });

  // ── 3) national_id immutable + .strict() (no mass-assignment) ───────
  it('3) schema rejects national_id / phone / name; PII columns never touched', () => {
    expect(
      PortalUpdateContactSchema.safeParse({ email: 'x@example.com', national_id: '305999999' })
        .success,
    ).toBe(false);
    expect(
      PortalUpdateContactSchema.safeParse({ email: 'x@example.com', phone: '0529999999' }).success,
    ).toBe(false);
    expect(
      PortalUpdateContactSchema.safeParse({ email: 'x@example.com', name: 'מתחזה' }).success,
    ).toBe(false);
    // The bare, valid shape still passes (sanity — .strict() isn't rejecting everything).
    expect(PortalUpdateContactSchema.safeParse({ email: 'x@example.com' }).success).toBe(true);
  });

  it('3b) updateContact leaves national_id + phone columns byte-for-byte unchanged', async () => {
    const before = await decryptPii(orgA, fx.ownerAId);
    await svc.updateContact(
      tenantOf(orgA, fx.ownerAId),
      { email: 'pii-check@example.com' },
      NO_CTX,
    );
    const after = await decryptPii(orgA, fx.ownerAId);
    expect(after.nationalId).toBe(before.nationalId);
    expect(after.nationalId).toBe(fx.ownerANationalId);
    expect(after.phone).toBe(before.phone);
    expect(after.phone).toBe(fx.ownerAPhone);
  });

  // ── 4) email clear + normalisation + bounds ─────────────────────────
  it('4) { email: null } stores NULL; malformed / >254 rejected; lowercased+trimmed', async () => {
    // Clear.
    const cleared = await svc.updateContact(tenantOf(orgA, fx.ownerAId), { email: null }, NO_CTX);
    expect(cleared.data.email).toBeNull();
    expect(await rawEmail(orgA, fx.ownerAId)).toBeNull();

    // Schema-level: lowercase + trim.
    const norm = PortalUpdateContactSchema.parse({ email: '  MixedCase@Example.COM  ' });
    expect(norm.email).toBe('mixedcase@example.com');

    // Malformed → 400 (safeParse false).
    expect(PortalUpdateContactSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);

    // >254 chars → rejected (RFC 5321 limit). Build a valid-shaped but
    // over-long address: long local-part + '@example.com'.
    const tooLong = 'a'.repeat(250) + '@example.com'; // 262 chars
    expect(tooLong.length).toBeGreaterThan(254);
    expect(PortalUpdateContactSchema.safeParse({ email: tooLong }).success).toBe(false);

    // The .strict() valid path with a trimmed/lowercased value round-trips to DB.
    await svc.updateContact(
      tenantOf(orgA, fx.ownerAId),
      PortalUpdateContactSchema.parse({ email: '  ReSt0re@Example.com ' }),
      NO_CTX,
    );
    expect(await rawEmail(orgA, fx.ownerAId)).toBe('rest0re@example.com');
  });

  // ── 5) 0-rows → NOT_FOUND (no oracle) ───────────────────────────────
  it('5) archived owner → NOT_FOUND (generic 404, no distinguishing oracle)', async () => {
    let caught: unknown;
    try {
      await svc.updateContact(
        tenantOf(orgA, fx.archivedOwnerId),
        { email: 'should-not-apply@example.com' },
        NO_CTX,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { response?: { error?: { code?: string } } }).response?.error?.code).toBe(
      'not_found',
    );
    // The archived owner's email was NOT changed (the WHERE excluded it).
    expect(await rawEmail(orgA, fx.archivedOwnerId)).toBe('archived@example.com');
  });

  it('5b) non-existent owner sub → same generic NOT_FOUND', async () => {
    let caught: unknown;
    try {
      await svc.updateContact(
        tenantOf(orgA, '11111111-1111-1111-1111-111111111111'),
        { email: 'ghost@example.com' },
        NO_CTX,
      );
    } catch (e) {
      caught = e;
    }
    expect((caught as { response?: { error?: { code?: string } } }).response?.error?.code).toBe(
      'not_found',
    );
  });

  // ── 6) PII never logged / audited ───────────────────────────────────
  it('6) audit afterState is EXACTLY {changed:[email]} — no email value, no national_id/phone', async () => {
    const newEmail = 'audit-probe-uniqueval@example.com';
    await svc.updateContact(tenantOf(orgA, fx.ownerBId), { email: newEmail }, NO_CTX);

    const [row] = await withTenant(orgA.id, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'portal.contact_update'), eq(auditLog.targetId, fx.ownerBId)),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(1),
    );

    expect(row).toBeDefined();
    // CHECK-constraint compliance + identity recorded structurally.
    expect(row!.actorType).toBe('system'); // 'tenant' would violate the CHECK
    expect(row!.targetTable).toBe('owners');
    expect(row!.targetId).toBe(fx.ownerBId);
    // afterState is EXACTLY {changed:['email']} — field NAMES only.
    expect(row!.afterState).toEqual({ changed: ['email'] });

    // Non-vacuous PII sweep: the email VALUE + both PII fields are absent
    // from the entire serialised audit row.
    const blob = JSON.stringify(row);
    expect(blob).not.toContain(newEmail);
    expect(blob).not.toContain('audit-probe-uniqueval');
    expect(blob).not.toContain(fx.ownerBNationalId);
    expect(blob).not.toContain(fx.ownerBPhone);
  });
});
