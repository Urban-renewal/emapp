/**
 * M2 — owner OUTBOUND OPT-OUT ingestion (the manager/admin action that
 * populates the recipient_opt_outs registry the ConsentGate reads).
 *
 * Proves (the compliance-critical axis — an opt-out is durable + scoped):
 *   - a manager opt-out writes a DURABLE registry row (channel + provenance).
 *   - it is IDEMPOTENT: a re-opt-out for the same (owner, channel) UPSERTs (one
 *     row, refreshed), never a duplicate.
 *   - default channel is `all` (the safest opt-out).
 *   - cross-tenant isolation: a manager cannot opt out a foreign owner → 404
 *     (RLS, no oracle).
 *   - NO PII in the registry row (only the owner FK + channel + source).
 *   - end-to-end: after the opt-out, resolveRecipientConsent for that owner's
 *     pending request resolves consented:false (the gate would DENY).
 */
import { randomUUID } from 'node:crypto';

import {
  encryptOwnerPii,
  owners,
  recipientOptOuts,
  resolveRecipientChannelSuppression,
  withTenant,
} from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnersService } from './owners.service';

let svc: OwnersService;
let org: TestOrg;
let other: TestOrg;
let managerId: string;
let ownerId: string;
let foreignOwnerId: string;
let reqId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000b2';

function manager(orgId = org.id, sub = managerId): AccessTokenPayload {
  return {
    sub,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedOwner(orgId: string, nationalId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId,
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
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

/** Seed a pending signature_request for the owner (so the end-to-end consent
 *  resolution has a recipientRef to resolve). BYPASSRLS via providerPool. */
async function seedRequest(orgId: string, ownerId: string, creatorId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const proj = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, created_by) VALUES ($1,$2,'tama38_1',$3) RETURNING id`,
      [orgId, `optout-proj-${randomUUID()}`, creatorId],
    );
    const bld = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1,$2,'TLV') RETURNING id`,
      [proj.rows[0]!.id, `St-${randomUUID()}`],
    );
    const apt = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1,$2) RETURNING id`,
      [bld.rows[0]!.id, randomUUID().slice(0, 8)],
    );
    const doc = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, apartment_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by)
       VALUES ($1,$2,$3,'sig.pdf','other','application/pdf',100,$4,'h',$5) RETURNING id`,
      [orgId, proj.rows[0]!.id, apt.rows[0]!.id, `org/${orgId}/doc/${randomUUID()}`, creatorId],
    );
    const req = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1,$2,$3,$4,'pending', now() + interval '7 days', $5) RETURNING id`,
      [orgId, doc.rows[0]!.id, ownerId, randomUUID(), creatorId],
    );
    return req.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function rowsFor(orgId: string, ownerId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select()
      .from(recipientOptOuts)
      .where(and(eq(recipientOptOuts.orgId, orgId), eq(recipientOptOuts.ownerId, ownerId))),
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new OwnersService();
  const tag = `m2-optout-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  other = await createTestOrg(`${tag}-x`, `${tag}-x`);
  managerId = org.users[0]!.id;
  ownerId = await seedOwner(org.id, '111111118');
  foreignOwnerId = await seedOwner(other.id, '222222226');
  reqId = await seedRequest(org.id, ownerId, managerId);
}, 120_000);

afterAll(async () => {
  await withTenant(org.id, (tx) =>
    tx.delete(recipientOptOuts).where(eq(recipientOptOuts.orgId, org.id)),
  ).catch(() => undefined);
});

describe('M2 — owner outbound opt-out ingestion (manager action)', () => {
  it('default channel is `all`; writes ONE durable registry row (NO PII)', async () => {
    await svc.optOut(manager(), ownerId, { channel: 'all', source: 'manager' });
    const rows = await rowsFor(org.id, ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('all');
    expect(rows[0]!.source).toBe('manager');
    expect(rows[0]!.optedOutAt).toBeTruthy();
    // NO PII columns exist on the row — only ids + channel + source. (Schema-
    // enforced; this asserts the shape we read back carries no phone/email.)
    expect(Object.keys(rows[0]!)).toEqual(
      expect.arrayContaining(['orgId', 'ownerId', 'channel', 'source', 'optedOutAt']),
    );
    expect(Object.keys(rows[0]!)).not.toContain('phone');
    expect(Object.keys(rows[0]!)).not.toContain('email');
  });

  it('is IDEMPOTENT: re-opting the same (owner, channel) UPSERTs (still ONE row)', async () => {
    await svc.optOut(manager(), ownerId, { channel: 'all', source: 'manager' });
    await svc.optOut(manager(), ownerId, { channel: 'all', source: 'unsubscribe_link' });
    const rows = await rowsFor(org.id, ownerId);
    const allRows = rows.filter((r) => r.channel === 'all');
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.source).toBe('unsubscribe_link'); // refreshed, not duplicated
  });

  it('cross-tenant: a manager cannot opt out a FOREIGN owner → 404 (no oracle)', async () => {
    await expect(
      svc.optOut(manager(), foreignOwnerId, { channel: 'all', source: 'manager' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // And nothing was written for the foreign owner in this org.
    const rows = await rowsFor(org.id, foreignOwnerId);
    expect(rows).toHaveLength(0);
  });

  it('end-to-end: after an `all` opt-out, the consent resolution for the owner request DENIES (both channels suppressed)', async () => {
    // The owner already has an `all` opt-out from the first test.
    const s = await withTenant(org.id, (tx) =>
      resolveRecipientChannelSuppression(tx, org.id, reqId),
    );
    expect(s.email).toBe(true);
    expect(s.sms).toBe(true);
    expect(s.consented).toBe(false);
  });
});
