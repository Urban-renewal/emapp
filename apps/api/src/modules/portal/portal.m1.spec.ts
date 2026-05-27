/**
 * V11 Wave 4 M-1 — tenant_sessions revocation gate (D.21 parity for the
 * Tenant Portal tier). Closes the "stolen-phone full TTL access" hole.
 *
 * Coverage (service + guard-level, no HTTP):
 *   1) OTP verify inserts a tenant_sessions row + mints a JWT with `sid`
 *   2) PortalService.logout soft-revokes the row (revoked_at set, no DELETE)
 *   3) isTenantSessionActive flips false after logout + cache flush
 *   4) Two parallel logins → distinct sids → revoking one leaves the other live
 *   5) audit_log row carries actor_type='system' (CHECK constraint compliance)
 *
 * Uses real Neon. Tenant identity = owner row (no `users` row needed).
 */
import { randomUUID } from 'node:crypto';

import {
  auditLog,
  db,
  encryptOwnerPii,
  hashField,
  type ISMSProvider,
  type SMSDeliveryResult,
  otpCodes,
  owners,
  tenantSessions,
  withTenant,
  env as dbEnv,
} from '@emapp/db';
import { normalizeIsraeliPhone } from '@emapp/validators';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { flushSessionCache, isTenantSessionActive } from '../auth/session-validity';
import { OtpService } from '../auth/tenant/otp.service';

import { PortalService } from './portal.service';

setupTestDatabase();

class FakeSms implements ISMSProvider {
  sent: Array<{ phone: string; body: string }> = [];
  async send(phone: string, body: string): Promise<SMSDeliveryResult> {
    this.sent.push({ phone, body });
    return { id: 'fake', status: 'sent' };
  }
  async healthCheck(): Promise<void> {
    /* noop */
  }
}

const SECRET = 'test-secret-wave4-m1-' + randomUUID();
const jwt = new JwtService({ secret: SECRET });

let orgA: TestOrg;
let aOwnerId = '';
const aPhone = '0541234567';

async function mintOtpFor(ownerId: string, orgId: string, phone: string): Promise<string> {
  const code = '123456';
  // OTP.verify normalises the inbound phone to E.164 before hashing
  // (otp.service line ~138), so the INSERT must hash the same form.
  const normalised = normalizeIsraeliPhone(phone);
  if (!normalised) throw new Error('mintOtpFor: phone normalise failed');
  await db.insert(otpCodes).values({
    phoneHash: hashField(normalised, dbEnv.PII_HASH_KEY as string),
    codeHash: hashField(code, dbEnv.PII_HASH_KEY as string),
    ownerId,
    orgId,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  return code;
}

async function makeOwner(o: TestOrg, phone: string): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as unknown as Parameters<typeof encryptOwnerPii>[0], {
      name: 'M1 Test',
      nationalId: `nid-${randomUUID()}`,
      phone,
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
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

beforeAll(async () => {
  orgA = await createTestOrg(`wave4-m1-${randomUUID().slice(0, 8)}`);
  aOwnerId = await makeOwner(orgA, aPhone);
});

afterAll(async () => {
  flushSessionCache();
});

describe('V11 Wave 4 M-1 · tenant_sessions revocation gate', () => {
  it('OTP verify inserts a tenant_sessions row + mints JWT carrying that sid', async () => {
    const sms = new FakeSms();
    const otp = new OtpService(jwt, sms);
    const code = await mintOtpFor(aOwnerId, orgA.id, aPhone);

    const { accessToken } = await otp.verify(aPhone, code, { ip: '1.1.1.1', userAgent: 'ua1' });
    expect(accessToken).toBeTruthy();

    const payload = jwt.decode(accessToken) as { sid: string; sub: string; orgId: string };
    expect(payload.sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.sub).toBe(aOwnerId);
    expect(payload.orgId).toBe(orgA.id);

    const [row] = await db
      .select()
      .from(tenantSessions)
      .where(eq(tenantSessions.id, payload.sid))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.ownerId).toBe(aOwnerId);
    expect(row!.orgId).toBe(orgA.id);
    expect(row!.revokedAt).toBeNull();
    expect(row!.ip).toBe('1.1.1.1');
    expect(row!.userAgent).toBe('ua1');

    flushSessionCache();
    expect(await isTenantSessionActive(payload.sid)).toBe(true);
  });

  it('PortalService.logout soft-revokes the row + flips isTenantSessionActive false', async () => {
    const sms = new FakeSms();
    const otp = new OtpService(jwt, sms);
    const code = await mintOtpFor(aOwnerId, orgA.id, aPhone);
    const { accessToken } = await otp.verify(aPhone, code);
    const { sid, sub, orgId } = jwt.decode(accessToken) as {
      sid: string;
      sub: string;
      orgId: string;
    };
    flushSessionCache();
    expect(await isTenantSessionActive(sid)).toBe(true);

    const portal = new PortalService();
    await portal.logout({ sub, orgId, role: 'tenant', type: 'tenant_access', sid });

    const [row] = await db.select().from(tenantSessions).where(eq(tenantSessions.id, sid)).limit(1);
    expect(row).toBeDefined();
    expect(row!.revokedAt).not.toBeNull(); // soft-revoke, not DELETE

    expect(await isTenantSessionActive(sid)).toBe(false);
  });

  it('two parallel logins → distinct sids; revoking one leaves the other live', async () => {
    const sms = new FakeSms();
    const otp = new OtpService(jwt, sms);
    const c1 = await mintOtpFor(aOwnerId, orgA.id, aPhone);
    const { accessToken: t1 } = await otp.verify(aPhone, c1);
    const c2 = await mintOtpFor(aOwnerId, orgA.id, aPhone);
    const { accessToken: t2 } = await otp.verify(aPhone, c2);

    const p1 = jwt.decode(t1) as { sid: string };
    const p2 = jwt.decode(t2) as { sid: string };
    expect(p1.sid).not.toBe(p2.sid);

    const portal = new PortalService();
    await portal.logout({
      sub: aOwnerId,
      orgId: orgA.id,
      role: 'tenant',
      type: 'tenant_access',
      sid: p1.sid,
    });
    flushSessionCache();
    expect(await isTenantSessionActive(p1.sid)).toBe(false);
    expect(await isTenantSessionActive(p2.sid)).toBe(true);
  });

  it('audit row uses actor_type="system" (CHECK constraint compliance)', async () => {
    const sms = new FakeSms();
    const otp = new OtpService(jwt, sms);
    const code = await mintOtpFor(aOwnerId, orgA.id, aPhone);
    const { accessToken } = await otp.verify(aPhone, code);
    const { sid, sub, orgId } = jwt.decode(accessToken) as {
      sid: string;
      sub: string;
      orgId: string;
    };
    const portal = new PortalService();
    await portal.logout({ sub, orgId, role: 'tenant', type: 'tenant_access', sid });

    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.tenant_logout'), eq(auditLog.orgId, orgA.id)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.actorType).toBe('system'); // NOT 'tenant' — CHECK rejects it
    expect(row!.targetTable).toBe('owners');
    expect(row!.targetId).toBe(sub);
  });
});
