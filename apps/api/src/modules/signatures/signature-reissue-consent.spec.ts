/**
 * M2 (consent-bypass HIGH follow-up) — end-to-end: `reissueAndDeliver` (the
 * executor for the `signature_request.reissue` proposal's APPROVE action) HONORS
 * the recipient opt-out registry PER CHANNEL — exactly like `sendGovernedReminder`.
 *
 * The defect this closes: `reissueAndDeliver` hard-coded `recipientConsented: true`
 * and called `resend(...)` with NO `suppress` arg, so an owner who opted out
 * (`POST /owners/:id/opt-out`, channel `all`) was honored on the cadence-reminder
 * path but STILL got an autonomous reissue email + SMS when a reissue proposal was
 * approved — ignoring a recorded legal consent withdrawal.
 *
 * Proves (counting the PROVIDER calls — the only ground truth for "did it send"):
 *   - no opt-out → BOTH channels sent (baseline).
 *   - sms-only opt-out → the SMS provider is NEVER called; email IS (the reissue
 *     re-delivery still succeeds on the permitted channel).
 *   - email-only opt-out → the EMAIL provider is NEVER called; sms IS.
 *   - `all` (or both) opt-out → the ConsentGate DENIES → NEITHER provider is
 *     called (the delivery state is `blocked`, before the ledger claim + any send).
 *
 * Mirrors `signature-governed-reminder-consent.spec.ts`; the only structural
 * differences are: the request is seeded `expired` (reissue requires it), the
 * proposal kind is `signature_request.reissue`, and the method returns
 * `{ request, delivery }` (a non-`sent` governed outcome surfaces as
 * `delivery.state`).
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
const MGR_SID = '00000000-0000-4000-8000-0000000000c3';
// Each case does several seed round-trips (expired request + reissue proposal) +
// the reissue's internal re-mint tx + the governed send — strictly heavier than
// the reminder spec. Give the remote DB room so a slow round-trip is patience,
// not a false red (the assertions, not the clock, are the gate).
const CASE_TIMEOUT_MS = 30_000;

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;
let projectId: string;

let emailCalls = 0;
let smsCalls = 0;

const tokenStub = {
  sign: () => ({
    token: `eyJ.reissue-${randomUUID()}`,
    jti: `jti-reissue-${randomUUID()}`,
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
      phone: '0541113333',
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

/** Seed an EXPIRED signature_request (reissue requires expired) + a pending
 *  `signature_request.reissue` proposal (the ledger proposal_id FK). Returns
 *  { reqId, ownerId, proposalId }. BYPASSRLS. */
async function seedReissueScope(): Promise<{
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
    // Reissue REQUIRES status='expired' (reissueExpired flips expired→pending);
    // an already-expired request also has expires_at in the past.
    const req = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1,$2,$3,$4,'expired', now() - interval '1 day', $5) RETURNING id`,
      [org.id, doc.rows[0]!.id, ownerId, randomUUID(), managerId],
    );
    const reqId = req.rows[0]!.id;
    const prop = await c.query<{ id: string }>(
      `INSERT INTO proposals (org_id, kind, status, scope_type, scope_id, evidence, dedup_key)
       VALUES ($1,'signature_request.reissue','pending','signature_request',$2,'{}'::jsonb,$3) RETURNING id`,
      [org.id, reqId, `signature_request.reissue:${reqId}:${randomUUID()}`],
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
  const tag = `m2-reissue-${Date.now()}`;
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

describe('M2 e2e — reissueAndDeliver honors opt-outs per channel', () => {
  it(
    'NO opt-out → BOTH channels sent (baseline)',
    async () => {
      const { reqId, proposalId } = await seedReissueScope();
      const out = await svc.reissueAndDeliver(manager(), {
        signatureRequestId: reqId,
        proposalId,
      });
      expect(out.delivery.delivered).toBe(true);
      expect(out.delivery.state).toBe('sent');
      expect(emailCalls).toBe(1);
      expect(smsCalls).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'sms-only opt-out → SMS provider NEVER called; email IS (reissue still delivers)',
    async () => {
      const { reqId, ownerId, proposalId } = await seedReissueScope();
      await optOut(ownerId, 'sms');
      const out = await svc.reissueAndDeliver(manager(), {
        signatureRequestId: reqId,
        proposalId,
      });
      expect(out.delivery.delivered).toBe(true);
      expect(out.delivery.state).toBe('sent');
      expect(emailCalls).toBe(1);
      expect(smsCalls).toBe(0); // the bug: this used to be 1
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'email-only opt-out → EMAIL provider NEVER called; sms IS',
    async () => {
      const { reqId, ownerId, proposalId } = await seedReissueScope();
      await optOut(ownerId, 'email');
      const out = await svc.reissueAndDeliver(manager(), {
        signatureRequestId: reqId,
        proposalId,
      });
      expect(out.delivery.delivered).toBe(true);
      expect(out.delivery.state).toBe('sent');
      expect(emailCalls).toBe(0); // the bug: this used to be 1
      expect(smsCalls).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '`all` opt-out → ConsentGate DENIES → NEITHER provider called (blocked)',
    async () => {
      const { reqId, ownerId, proposalId } = await seedReissueScope();
      await optOut(ownerId, 'all');
      const out = await svc.reissueAndDeliver(manager(), {
        signatureRequestId: reqId,
        proposalId,
      });
      expect(out.delivery.delivered).toBe(false);
      expect(out.delivery.state).toBe('blocked');
      expect(emailCalls).toBe(0); // the bug: this used to be 1
      expect(smsCalls).toBe(0); // the bug: this used to be 1
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'BOTH channels opted out → ConsentGate DENIES → NEITHER provider called',
    async () => {
      const { reqId, ownerId, proposalId } = await seedReissueScope();
      await optOut(ownerId, 'email');
      await optOut(ownerId, 'sms');
      const out = await svc.reissueAndDeliver(manager(), {
        signatureRequestId: reqId,
        proposalId,
      });
      expect(out.delivery.delivered).toBe(false);
      expect(out.delivery.state).toBe('blocked');
      expect(emailCalls).toBe(0);
      expect(smsCalls).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});
