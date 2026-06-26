/**
 * DELIVERY-OUTCOME HONESTY for the proposal-approve REISSUE executor (#16) —
 * adversarial, deterministic real-DB spec authored as the test author (does NOT
 * touch the impl).
 *
 * Feature under test: SignatureRequestsService.reissueAndDeliver(user, input) —
 * the executor behind `signature_request.reissue` proposal approval. It re-mints
 * an EXPIRED request's link AND governed-sends it, THEN — for LEGIBILITY — fires
 * an in-app "owner re-notified" (`signature_received`) notification.
 *
 * THE BUG (#16): a reissue whose send actually FAILED (the owner has NO email AND
 * NO phone, so NO channel can carry the link) must NOT be laundered into a false
 * "delivered" + a false "received" notification. The notification is the
 * recipient-facing claim "the owner got it"; firing it on a non-send is a lie.
 *
 * The contract this pins (the canonical `didAnyChannelDeliver` gate):
 *  - DELIVERED (email actually went) → `delivered:true`, `state:'sent'`, AND the
 *    `signature_received` notification fires (the manager legitimately sees
 *    "owner re-notified").
 *  - NO-CHANNEL (no email + no phone → nothing sent) → `delivered:false`, a
 *    non-`sent` state, AND the notification does NOT fire. The link was still
 *    re-minted (the row flips expired→pending) so the manager can deliver it
 *    manually — but the system never claims it reached the owner.
 *
 * Seeding mirrors signature-requests-resend.spec.ts. The notifications producer
 * is a SPY (records emitMany) so "did the false-received notification fire?" is a
 * hard assertion, not an inference.
 */
import { randomUUID } from 'node:crypto';

import { db, encryptOwnerPii, memberships, owners, users, withTenant } from '@emapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import type { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;
let projectId: string;
let doc: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `eyJhbGciOiJIUzI1NiJ9.REISSUEHONESTY.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-reissue-honesty-${mintCount}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    };
  },
} as never;

// Both providers REPORT 'sent' — so the delivered-vs-no-channel split is driven
// PURELY by whether the owner has a channel ON FILE (email/phone), never by a
// provider error. A no-channel owner can't even reach these stubs.
const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => ({ id: 's-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

// SPY notifications producer — records every emitMany so we can assert the
// "owner re-notified" (`signature_received`) notification fires for a real
// delivery and does NOT fire for a non-send.
const emitManyCalls: Array<{ recipients: readonly string[]; type: string }> = [];
const notificationsSpy = {
  emit: vi.fn(async () => true),
  emitMany: vi.fn(async (recipients: readonly string[], base: { type: string }) => {
    emitManyCalls.push({ recipients, type: base.type });
    return recipients.length;
  }),
} as unknown as NotificationsProducerService;

function manager(orgId = org.id): AccessTokenPayload {
  return {
    sub: managerId,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function natId(): string {
  return String(Math.floor(100000000 + Math.random() * 899999999));
}

async function seedDoc(orgId: string, pid: string, mgrId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'd.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now()) RETURNING id`,
      [orgId, pid, `org/${orgId}/doc/${randomUUID()}`, mgrId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Seed an owner. `withChannels=false` → NO email AND NO phone → a reissue can
 *  reach NO channel (the #16 no-channel case). */
async function seedOwner(orgId: string, withChannels: boolean): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      ...(withChannels ? { phone: '0541112222' } : {}),
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: withChannels ? `owner-${randomUUID()}@test.local` : null,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted ?? null,
        phoneHash: pii.phoneHash ?? null,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Pre-create an EXPIRED signature_request (the only reissuable state). */
async function seedExpiredRequest(
  orgId: string,
  documentId: string,
  owner: string,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'expired', now() - interval '1 day', $5) RETURNING id`,
      [orgId, documentId, owner, 'jti-seed-' + randomUUID(), managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Seed a pending reissue PROPOSAL (BYPASSRLS). The outbound_ledger row the
 *  governor writes FKs to proposals.id, so the proposalId must be a real row. */
async function seedProposal(orgId: string, scopeId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO proposals (org_id, kind, status, scope_type, scope_id, evidence, dedup_key, actor_type)
       VALUES ($1, 'signature_request.reissue', 'pending', 'signature_request', $2, $3::jsonb, $4, 'system')
       RETURNING id`,
      [
        orgId,
        scopeId,
        JSON.stringify({ signatureRequestId: scopeId, reason: 'expired_unsigned' }),
        `signature_request.reissue:${scopeId}:${randomUUID()}`,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Seed a SECOND manager in the org — a non-actor recipient, so the delivered
 *  control can observe the "owner re-notified" notification actually fanning out
 *  (the producer EXCLUDES the actor, so a single-manager org would notify no one). */
async function seedSecondManager(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `mgr2-${randomUUID()}@test.local`,
      name: 'Manager 2',
      passwordHash: '$2b$12$x',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'manager', acceptedAt: new Date() });
  return u!.id;
}

async function readStatus(id: string): Promise<string | null> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ status: string }>(
      `SELECT status FROM signature_requests WHERE id = $1`,
      [id],
    );
    return r.rows[0]?.status ?? null;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub, undefined, notificationsSpy);
  const tag = `reissue-honesty-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
  doc = await seedDoc(org.id, projectId, managerId);
  // A non-actor manager so the delivered-path notification has a real recipient
  // (the producer excludes the approver from the fan-out).
  await seedSecondManager(org.id);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

beforeEach(() => {
  emitManyCalls.length = 0;
  (notificationsSpy.emitMany as ReturnType<typeof vi.fn>).mockClear();
});

describe('reissueAndDeliver — DELIVERED owner (control: the honest path still notifies)', () => {
  it('REH-1) owner WITH email → delivered:true, state sent, AND the "owner re-notified" notification fires', async () => {
    const owner = await seedOwner(org.id, true);
    const reqId = await seedExpiredRequest(org.id, doc, owner);
    const proposalId = await seedProposal(org.id, reqId);

    const { delivery } = await svc.reissueAndDeliver(manager(), {
      signatureRequestId: reqId,
      proposalId,
    });

    expect(delivery.delivered).toBe(true);
    expect(delivery.state).toBe('sent');
    // The link was revived: expired → pending.
    expect(await readStatus(reqId)).toBe('pending');
    // The legibility notification fired — and it is the signature_received type.
    expect(emitManyCalls).toHaveLength(1);
    expect(emitManyCalls[0]!.type).toBe('signature_received');
  }, 30_000);
});

describe('reissueAndDeliver — NO-CHANNEL owner (#16: a failed send must NOT claim delivered / received)', () => {
  it('REH-2) owner with NO email AND NO phone → delivered:false, state NOT sent, and NO notification fires', async () => {
    const owner = await seedOwner(org.id, false);
    const reqId = await seedExpiredRequest(org.id, doc, owner);
    const proposalId = await seedProposal(org.id, reqId);

    const { delivery } = await svc.reissueAndDeliver(manager(), {
      signatureRequestId: reqId,
      proposalId,
    });

    // HONESTY: nothing reached the owner — never report a delivery.
    expect(delivery.delivered).toBe(false);
    expect(delivery.state).not.toBe('sent');
    // The re-mint still stands (the row is pending again) so the manager can
    // deliver the link manually — the renewal is not lost, it's just not "sent".
    expect(await readStatus(reqId)).toBe('pending');
    // THE CRUX: the "owner re-notified" / signature_received notification must
    // NOT fire — the owner did not receive anything.
    expect(notificationsSpy.emitMany).not.toHaveBeenCalled();
    expect(emitManyCalls).toHaveLength(0);
  }, 30_000);
});
