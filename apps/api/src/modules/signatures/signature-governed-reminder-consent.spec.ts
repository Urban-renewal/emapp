/**
 * M2 (red-team follow-up) — end-to-end: `sendGovernedReminder` HONORS the
 * recipient opt-out registry PER CHANNEL.
 *
 * The defect the M2 red-team found: the governed reminder resolved consent for
 * `email` only, but `deliverSignatureLink` fans out to BOTH email AND sms — so an
 * owner who opted out of `sms` was still SMS'd. This spec asserts the wiring at
 * the boundary that matters: the SMS / email PROVIDER is NOT called for a
 * suppressed channel, and is called for a permitted one.
 *
 * Proves:
 *   - sms-only opt-out → the SMS provider is NEVER called; email IS (the send
 *     still succeeds on the permitted channel).
 *   - email-only opt-out → the EMAIL provider is NEVER called; sms IS.
 *   - `all` (or both) opt-out → the ConsentGate DENIES → NEITHER provider is
 *     called (blocked before the ledger claim + before any send).
 *   - no opt-out → both channels are sent (baseline).
 *
 * Counts the PROVIDER calls (the only ground truth for "did it actually send").
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, recipientOptOuts, withTenant } from '@emapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MGR_SID = '00000000-0000-4000-8000-0000000000c2';

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;
let projectId: string;

let emailCalls = 0;
let smsCalls = 0;

const tokenStub = {
  sign: () => ({
    token: `eyJ.gov-${randomUUID()}`,
    jti: `jti-gov-${randomUUID()}`,
    expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
  }),
} as never;
const emailStub = {
  send: async () => {
    emailCalls += 1;
    return { id: 'e-' + randomUUID(), status: 'sent' as const };
  },
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => {
    smsCalls += 1;
    return { id: 's-' + randomUUID(), status: 'sent' as const };
  },
  healthCheck: async () => undefined,
} as never;

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedOwner(): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: String(Math.floor(100000000 + Math.random() * 899999999)),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: `owner-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Seed a pending signature_request + a pending reminder proposal (the ledger
 *  proposal_id FK). Returns { reqId, ownerId, proposalId }. BYPASSRLS. */
async function seedReminderScope(): Promise<{
  reqId: string;
  ownerId: string;
  proposalId: string;
}> {
  const ownerId = await seedOwner();
  const c = await providerPool.connect();
  try {
    const doc = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1,$2,'d.pdf','contract','application/pdf',100,$3,'h',$4, now()) RETURNING id`,
      [org.id, projectId, `org/${org.id}/doc/${randomUUID()}`, managerId],
    );
    const req = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1,$2,$3,$4,'pending', now() + interval '7 days', $5) RETURNING id`,
      [org.id, doc.rows[0]!.id, ownerId, randomUUID(), managerId],
    );
    const reqId = req.rows[0]!.id;
    const prop = await c.query<{ id: string }>(
      `INSERT INTO proposals (org_id, kind, status, scope_type, scope_id, evidence, dedup_key)
       VALUES ($1,'reminder.send','pending','signature_request',$2,'{}'::jsonb,$3) RETURNING id`,
      [org.id, reqId, `reminder.send:${reqId}:${randomUUID()}`],
    );
    return { reqId, ownerId, proposalId: prop.rows[0]!.id };
  } finally {
    c.release();
  }
}

async function optOut(ownerId: string, channel: 'email' | 'sms' | 'all'): Promise<void> {
  await withTenant(org.id, (tx) =>
    tx.insert(recipientOptOuts).values({ orgId: org.id, ownerId, channel, source: 'manager' }),
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `m2-gov-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 120_000);

afterAll(async () => {
  await withTenant(org.id, (tx) =>
    tx.delete(recipientOptOuts).where(eq(recipientOptOuts.orgId, org.id)),
  ).catch(() => undefined);
});

beforeEach(() => {
  emailCalls = 0;
  smsCalls = 0;
});

describe('M2 e2e — sendGovernedReminder honors opt-outs per channel', () => {
  it('NO opt-out → BOTH channels sent (baseline)', async () => {
    const { reqId, proposalId } = await seedReminderScope();
    const out = await svc.sendGovernedReminder(manager(), {
      proposalId,
      signatureRequestId: reqId,
      cadenceStep: 0,
    });
    expect(out.result).toBe('sent');
    expect(emailCalls).toBe(1);
    expect(smsCalls).toBe(1);
  });

  it('sms-only opt-out → SMS provider NEVER called; email IS (send still succeeds)', async () => {
    const { reqId, ownerId, proposalId } = await seedReminderScope();
    await optOut(ownerId, 'sms');
    const out = await svc.sendGovernedReminder(manager(), {
      proposalId,
      signatureRequestId: reqId,
      cadenceStep: 0,
    });
    expect(out.result).toBe('sent');
    expect(emailCalls).toBe(1);
    expect(smsCalls).toBe(0); // the bug: this used to be 1
  });

  it('email-only opt-out → EMAIL provider NEVER called; sms IS', async () => {
    const { reqId, ownerId, proposalId } = await seedReminderScope();
    await optOut(ownerId, 'email');
    const out = await svc.sendGovernedReminder(manager(), {
      proposalId,
      signatureRequestId: reqId,
      cadenceStep: 0,
    });
    expect(out.result).toBe('sent');
    expect(emailCalls).toBe(0);
    expect(smsCalls).toBe(1);
  });

  it('`all` opt-out → ConsentGate DENIES → NEITHER provider called (blocked)', async () => {
    const { reqId, ownerId, proposalId } = await seedReminderScope();
    await optOut(ownerId, 'all');
    const out = await svc.sendGovernedReminder(manager(), {
      proposalId,
      signatureRequestId: reqId,
      cadenceStep: 0,
    });
    expect(out.result).toBe('blocked');
    expect(emailCalls).toBe(0);
    expect(smsCalls).toBe(0);
  });

  it('BOTH channels opted out → ConsentGate DENIES → NEITHER provider called', async () => {
    const { reqId, ownerId, proposalId } = await seedReminderScope();
    await optOut(ownerId, 'email');
    await optOut(ownerId, 'sms');
    const out = await svc.sendGovernedReminder(manager(), {
      proposalId,
      signatureRequestId: reqId,
      cadenceStep: 0,
    });
    expect(out.result).toBe('blocked');
    expect(emailCalls).toBe(0);
    expect(smsCalls).toBe(0);
  });
});
