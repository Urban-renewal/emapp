/**
 * HB-1 — PROJECT-scoped "remind the PENDING signers" (the stuck-pending chase).
 * Adversarial, deterministic real-DB acceptance spec authored alongside the
 * impl. Exercises the SERVICE method directly (mirroring
 * signature-campaign.spec.ts + signature-requests-resend.spec.ts) because the
 * whole value is the PENDING-derivation + per-request resend-reuse + the
 * authz/kill-switch ordering that lives in the service; the controller/guard
 * layer is already covered by the signatures suites.
 *
 * Feature under test:
 *   POST /api/v1/projects/:id/signature-requests/remind  (NO body)
 *   svc.remindProjectPending(user, projectId) → { reminded, total }
 *
 * The server DERIVES every LIVE PENDING signature request of the project
 * (status='pending' AND expires_at > now(), joined ownership → apartment →
 * building → project = :id), re-mints a fresh token + 7-day expiry for each
 * (REUSING the per-request resend path), and re-delivers it. The client supplies
 * neither ownerIds nor a documentId.
 *
 * Threat model probed here (the real security/biz bugs):
 *  - Does it re-spam a SIGNED owner? (must NOT — pending-only.)
 *  - Is an EXPIRED-but-still-'pending' row excluded? (expires_at > now() filter.)
 *  - Is the OLD link actually re-minted for the chased rows? (jti changes.)
 *  - Kill-switch OFF → 503 campaign_send_disabled + ZERO re-mint (no jti change).
 *  - Is the kill-switch checked AFTER authz? (an UNASSIGNED agent gets 404, NOT
 *    503 — no state oracle to an unauthorized caller, even with the switch off.)
 *  - viewer (no signature_requests.send) / unassigned-or-uncapable agent → 403/404.
 *  - cross-org project → no-oracle 404, zero mutation.
 *  - audit rows carry NO PII (only the request id as target).
 *
 * Idempotency (double-submit doesn't double-SEND) is enforced by the global
 * IdempotencyInterceptor (POST, route-keyed) and covered by its own spec
 * (idempotency.interceptor.spec) — it is route-agnostic, so it is not re-proved
 * per endpoint here. At the SERVICE level a second remind on STILL-pending rows
 * legitimately re-mints again (that is resend semantics, not a double-send bug);
 * we assert that contract holds (it does not, e.g., create NEW rows).
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import { db, encryptOwnerPii, memberships, owners, users, withTenant } from '@emapp/db';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let foreignOrg: TestOrg;
let managerId: string;
let agentId: string;
let viewerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000d2';
const VIEWER_SID = '00000000-0000-4000-8000-0000000000d3';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Fresh, JWT-shaped token + fresh jti each call (like the real tokenService) so
 *  "the row's jti changed" is a meaningful re-mint assertion. */
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.REMINDSPECTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-remind-${mintCount}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    };
  },
} as never;

const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => ({ id: 's-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

function manager(orgId = org.id): AccessTokenPayload {
  return { sub: managerId, orgId, role: 'manager', sid: MGR_SID, type: 'access' } as never;
}
function agent(): AccessTokenPayload {
  return { sub: agentId, orgId: org.id, role: 'agent', sid: AGENT_SID, type: 'access' } as never;
}
function viewer(): AccessTokenPayload {
  return { sub: viewerId, orgId: org.id, role: 'viewer', sid: VIEWER_SID, type: 'access' } as never;
}

/** Save/restore-mutate the live `serverEnv.CAMPAIGN_SEND_ENABLED` (mirrors
 *  signature-campaign.spec withSendFlag). */
const SEND_FLAG = 'CAMPAIGN_SEND_ENABLED' as const;
async function withSendFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const env = serverEnv as unknown as Record<string, string | undefined>;
  const had = Object.prototype.hasOwnProperty.call(env, SEND_FLAG);
  const prev = env[SEND_FLAG];
  if (value === undefined) delete env[SEND_FLAG];
  else env[SEND_FLAG] = value;
  try {
    return await fn();
  } finally {
    if (had) env[SEND_FLAG] = prev;
    else delete env[SEND_FLAG];
  }
}

let nidCounter = 800000001;
function natId(): string {
  return String(nidCounter++);
}

async function seedAgent(orgId: string, role: 'agent' | 'viewer', cap: boolean): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${role}-${randomUUID()}@test.local`, name: role, passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db.insert(memberships).values({ userId: u!.id, orgId, role, acceptedAt: new Date() });
  if (cap) {
    // Set the manage_signatures capability via raw SQL (mirrors the resend
    // spec's setCap) — the typed `capabilities` column wants the full object.
    const c = await providerPool.connect();
    try {
      await c.query(
        `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{manage_signatures}', 'true'::jsonb)
         WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL`,
        [u!.id, orgId],
      );
    } finally {
      c.release();
    }
  }
  return u!.id;
}

async function assignAgent(projectId: string, userId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO project_assignments (project_id, user_id, assigned_by) VALUES ($1, $2, $3)`,
      [projectId, userId, managerId],
    );
  } finally {
    c.release();
  }
}

async function seedProject(orgId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, status, created_by)
       VALUES ($1, $2, 'tama38_1', 'gathering_signatures', $3) RETURNING id`,
      [orgId, `Proj-${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedBuilding(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
      [projectId, `St-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedApartment(buildingId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [buildingId, randomUUID().slice(0, 8)],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        email: `owner-${randomUUID()}@test.local`,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function seedSoleOwnership(apartmentId: string, ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship)
       VALUES ($1, $2, 100.00, 'owner')`,
      [apartmentId, ownerId],
    );
  } finally {
    c.release();
  }
}

async function seedProjectDoc(orgId: string, projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'plan.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now())
       RETURNING id`,
      [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Pre-create a signature_request at a chosen status + expiry directly. */
async function seedRequest(
  orgId: string,
  documentId: string,
  ownerId: string,
  status: 'pending' | 'signed' | 'cancelled',
  expiresInterval = "now() + interval '2 days'",
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, ${expiresInterval}, $6) RETURNING id`,
      [orgId, documentId, ownerId, 'jti-seed-' + randomUUID(), status, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Ground-truth read (BYPASSRLS) — the oracle for "did this row get re-minted". */
async function readRow(id: string): Promise<{ jti: string; status: string } | null> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ jti: string; status: string }>(
      `SELECT jti, status FROM signature_requests WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row ? { jti: row.jti, status: row.status } : null;
  } finally {
    c.release();
  }
}

async function countRowsForDoc(documentId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signature_requests WHERE document_id = $1`,
      [documentId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** All audit rows for the resend action whose target is one of `ids`, plus the
 *  serialized row text — so we can assert NO PII leaked into any audit field. */
async function readResendAudits(ids: string[]): Promise<Array<Record<string, unknown>>> {
  if (ids.length === 0) return [];
  const c = await providerPool.connect();
  try {
    const r = await c.query<Record<string, unknown>>(
      `SELECT * FROM audit_log
       WHERE action = 'signature_request.resend' AND target_id = ANY($1::uuid[])`,
      [ids],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `remind-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  agentId = await seedAgent(org.id, 'agent', true);
  viewerId = await seedAgent(org.id, 'viewer', false);
  foreignOrg = await createTestOrg(`remind-foreign-${Date.now()}`, `remind-foreign-${Date.now()}`);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('HB-1 remind — PENDING-only recipient scope', () => {
  it('REM-1) reminds ONLY live-pending; signed + cancelled owners are NOT re-minted', async () => {
    const projectId = await seedProject(org.id);
    const b = await seedBuilding(projectId);
    const [a1, a2, a3] = [await seedApartment(b), await seedApartment(b), await seedApartment(b)];
    const [o1, o2, o3] = [await seedOwner(org.id), await seedOwner(org.id), await seedOwner(org.id)];
    await seedSoleOwnership(a1, o1);
    await seedSoleOwnership(a2, o2);
    await seedSoleOwnership(a3, o3);
    const doc = await seedProjectDoc(org.id, projectId);

    const pending = await seedRequest(org.id, doc, o1, 'pending');
    const signed = await seedRequest(org.id, doc, o2, 'signed');
    const cancelled = await seedRequest(org.id, doc, o3, 'cancelled');

    const before = {
      pending: (await readRow(pending))!.jti,
      signed: (await readRow(signed))!.jti,
      cancelled: (await readRow(cancelled))!.jti,
    };

    const res = await svc.remindProjectPending(manager(), projectId);

    // total = live-pending count (1). reminded = delivered (1, owner has email+phone).
    expect(res.total).toBe(1);
    expect(res.reminded).toBe(1);

    // Only the pending row's jti changed (re-minted). signed + cancelled untouched.
    expect((await readRow(pending))!.jti).not.toBe(before.pending);
    expect((await readRow(signed))!.jti).toBe(before.signed);
    expect((await readRow(signed))!.status).toBe('signed');
    expect((await readRow(cancelled))!.jti).toBe(before.cancelled);
    // No NEW rows created (remind re-mints in place; never inserts).
    expect(await countRowsForDoc(doc)).toBe(3);
  }, 60_000);

  it('REM-2) an EXPIRED-but-still-pending request is EXCLUDED (expires_at > now() filter)', async () => {
    const projectId = await seedProject(org.id);
    const b = await seedBuilding(projectId);
    const [aLive, aExp] = [await seedApartment(b), await seedApartment(b)];
    const [oLive, oExp] = [await seedOwner(org.id), await seedOwner(org.id)];
    await seedSoleOwnership(aLive, oLive);
    await seedSoleOwnership(aExp, oExp);
    const doc = await seedProjectDoc(org.id, projectId);

    const live = await seedRequest(org.id, doc, oLive, 'pending');
    // status still 'pending' but expiry is in the PAST → must be excluded.
    const expired = await seedRequest(org.id, doc, oExp, 'pending', "now() - interval '1 day'");
    const expiredJtiBefore = (await readRow(expired))!.jti;

    const res = await svc.remindProjectPending(manager(), projectId);

    expect(res.total).toBe(1);
    expect(res.reminded).toBe(1);
    // the live one was re-minted; the expired one was NOT touched.
    expect((await readRow(live))!.jti).not.toBe('');
    expect((await readRow(expired))!.jti).toBe(expiredJtiBefore);
  }, 60_000);

  it('REM-3) a SECOND remind on still-pending rows re-mints again but creates NO new rows', async () => {
    const projectId = await seedProject(org.id);
    const b = await seedBuilding(projectId);
    const a = await seedApartment(b);
    const o = await seedOwner(org.id);
    await seedSoleOwnership(a, o);
    const doc = await seedProjectDoc(org.id, projectId);
    const req = await seedRequest(org.id, doc, o, 'pending');

    await svc.remindProjectPending(manager(), projectId);
    const jtiAfter1 = (await readRow(req))!.jti;
    await svc.remindProjectPending(manager(), projectId);
    const jtiAfter2 = (await readRow(req))!.jti;

    expect(jtiAfter2).not.toBe(jtiAfter1); // re-minted (resend semantics)
    expect(await countRowsForDoc(doc)).toBe(1); // no duplicate row
  }, 60_000);
});

describe('HB-1 remind — N15 kill-switch (AFTER authz, no oracle)', () => {
  it("REM-4) CAMPAIGN_SEND_ENABLED='0' → 503 campaign_send_disabled, ZERO re-mint", async () => {
    const projectId = await seedProject(org.id);
    const b = await seedBuilding(projectId);
    const a = await seedApartment(b);
    const o = await seedOwner(org.id);
    await seedSoleOwnership(a, o);
    const doc = await seedProjectDoc(org.id, projectId);
    const req = await seedRequest(org.id, doc, o, 'pending');
    const jtiBefore = (await readRow(req))!.jti;

    let caught: unknown;
    await withSendFlag('0', async () => {
      try {
        await svc.remindProjectPending(manager(), projectId);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getResponse()).toEqual({
      error: { code: 'campaign_send_disabled' },
    });
    // Kill-switch gates BEFORE any re-mint → the pending row's jti is unchanged.
    expect((await readRow(req))!.jti).toBe(jtiBefore);
  }, 60_000);

  it('REM-5) kill-switch is checked AFTER authz: an UNASSIGNED agent gets 404, NOT 503 (no state oracle)', async () => {
    const projectId = await seedProject(org.id); // agent is NOT assigned to this project
    const b = await seedBuilding(projectId);
    const a = await seedApartment(b);
    const o = await seedOwner(org.id);
    await seedSoleOwnership(a, o);
    await seedProjectDoc(org.id, projectId);

    // Switch is OFF — but the unassigned agent must STILL get a 404 (the authz
    // gate resolves first), never learning the switch state.
    let caught: unknown;
    await withSendFlag('0', async () => {
      try {
        await svc.remindProjectPending(agent(), projectId);
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBeInstanceOf(NotFoundException);
  }, 60_000);
});

describe('HB-1 remind — permission / capability / assignment gates', () => {
  it('REM-6) viewer (no signature_requests.send capability) is rejected; an ASSIGNED + CAPABLE agent succeeds', async () => {
    const projectId = await seedProject(org.id);
    const b = await seedBuilding(projectId);
    const a = await seedApartment(b);
    const o = await seedOwner(org.id);
    await seedSoleOwnership(a, o);
    const doc = await seedProjectDoc(org.id, projectId);
    await seedRequest(org.id, doc, o, 'pending');

    // A viewer has no `manage_signatures` capability → the service fine-gate
    // rejects (the coarse RequirePermission guard also bars them at the HTTP
    // layer; here we prove the service does not silently allow them).
    await expect(svc.remindProjectPending(viewer(), projectId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // Assign + (already capable) agent → succeeds and reminds the pending owner.
    await assignAgent(projectId, agentId);
    const res = await svc.remindProjectPending(agent(), projectId);
    expect(res.total).toBe(1);
    expect(res.reminded).toBe(1);
  }, 60_000);

  it('REM-7) an UNASSIGNED agent → no-oracle 404 (cannot remind a project they cannot see)', async () => {
    const projectId = await seedProject(org.id); // not assigned to `agent`
    const b = await seedBuilding(projectId);
    const a = await seedApartment(b);
    const o = await seedOwner(org.id);
    await seedSoleOwnership(a, o);
    const doc = await seedProjectDoc(org.id, projectId);
    await seedRequest(org.id, doc, o, 'pending');

    await expect(svc.remindProjectPending(agent(), projectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  }, 60_000);
});

describe('HB-1 remind — cross-org + audit hygiene', () => {
  it('REM-8) a project in ANOTHER org → no-oracle 404, ZERO mutation', async () => {
    const foreignProjectId = foreignOrg.projects[0]!.id;
    const b = await seedBuilding(foreignProjectId);
    const a = await seedApartment(b);
    const fOwner = await seedOwner(foreignOrg.id);
    await seedSoleOwnership(a, fOwner);
    const fDoc = await seedProjectDoc(foreignOrg.id, foreignProjectId);
    const fReq = await seedRequest(foreignOrg.id, fDoc, fOwner, 'pending');
    const before = (await readRow(fReq))!.jti;

    await expect(svc.remindProjectPending(manager(), foreignProjectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await readRow(fReq))!.jti).toBe(before);
  }, 60_000);

  it('REM-9) the resend audit rows carry NO PII (only the request id as target)', async () => {
    const projectId = await seedProject(org.id);
    const b = await seedBuilding(projectId);
    const a = await seedApartment(b);
    const o = await seedOwner(org.id);
    await seedSoleOwnership(a, o);
    const doc = await seedProjectDoc(org.id, projectId);
    const req = await seedRequest(org.id, doc, o, 'pending');

    await svc.remindProjectPending(manager(), projectId);

    const audits = await readResendAudits([req]);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    // No PII (national id / phone / the seeded name / owner email) anywhere in
    // the serialized audit rows. target_id is the REQUEST id, not the owner.
    const blob = JSON.stringify(audits);
    expect(blob).not.toContain('בעלים'); // seeded owner name
    expect(blob).not.toContain('0541112222'); // seeded phone
    for (const row of audits) {
      expect(row['target_table']).toBe('signature_requests');
      expect(row['target_id']).toBe(req);
    }
  }, 60_000);
});
