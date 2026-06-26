/**
 * W-4.1 — cross-party recipient capture + party_request (who-owes-what) spec.
 * Runs against the real local DB (migration 0087 applied by global-setup).
 *
 * Covers:
 *   - recipient email/phone are ENCRYPTED at rest (ciphertext in the column,
 *     plaintext NOWHERE) and returned MASKED-ONLY on every read path.
 *   - delivery_channel defaults to manual_link; last_delivered_at stays NULL
 *     (4.1 never sends).
 *   - party_request CRUD: create / list-open / cancel, all withTenant +
 *     suspended-gated + no-oracle.
 *   - partial-unique: a second LIVE obligation for the same (project, party,
 *     doc-type) is rejected; cancelling the first releases the slot.
 *   - cancel is a STATUS transition (DELETE is revoked at the DB layer).
 *   - RLS: org B cannot see / cancel org A's obligation.
 */
import { externalShares, partyRequests } from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ExternalSharesService } from './external-shares.service';

let svc: ExternalSharesService;
let orgA: TestOrg;
let orgB: TestOrg;
let projectAId: string;
let projectBId: string;

function manager(org: TestOrg): AccessTokenPayload {
  return {
    sub: org.users[0]!.id,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-000000000001',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function setSuspended(orgId: string, suspended: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE organizations SET suspended_at = ${suspended ? 'now()' : 'NULL'} WHERE id = $1`,
      [orgId],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ExternalSharesService();
  orgA = await createTestOrg(`pra-${Date.now()}`, `pra-${Date.now()}`);
  orgB = await createTestOrg(`prb-${Date.now()}`, `prb-${Date.now()}`);
  projectAId = orgA.projects[0]!.id;
  projectBId = orgB.projects[0]!.id;
});

afterAll(async () => {
  await setSuspended(orgA.id, false);
  await setSuspended(orgB.id, false);
});

describe('W-4.1 — recipient capture: encrypted at rest, masked on the wire', () => {
  it('encrypts email/phone, returns MASKED only, defaults delivery_channel + NULL last_delivered_at', async () => {
    const v = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: {
        overview: { on: true },
        documents: { on: true, actions: { download: true } },
        signatures: { on: true },
      },
      allowSensitive: false,
      otpRequired: true,
      recipientName: 'עו״ד כהן',
      recipientEmail: 'avi.cohen@example.com',
      recipientPhone: '0541234599',
      deliveryChannel: 'email',
    });

    // Masked-only projection on the wire — NEVER the raw value.
    expect(v.recipientName).toBe('עו״ד כהן');
    expect(v.recipientEmailMasked).toBe('av***@example.com');
    expect(v.recipientPhoneMasked).toBe('••••••99');
    expect(v.recipientEmailMasked).not.toContain('avi.cohen');
    // The view contract has NO raw recipientEmail/recipientPhone key at all.
    expect((v as Record<string, unknown>).recipientEmail).toBeUndefined();
    expect((v as Record<string, unknown>).recipientPhone).toBeUndefined();
    // 4.1 captures intent; it never sends.
    expect(v.deliveryChannel).toBe('email');
    expect(v.lastDeliveredAt).toBeNull();

    // At rest: the column holds CIPHERTEXT (bytea), and decrypting it under the
    // PII key round-trips to the original plaintext — proving real encryption,
    // not a plaintext smuggle. Read via the provider (BYPASSRLS) pool.
    const c = await providerPool.connect();
    try {
      const raw = await c.query<{
        recipient_email_encrypted: Buffer | null;
        recipient_phone_encrypted: Buffer | null;
        recipient_name: string | null;
        decrypted_email: string | null;
        decrypted_phone: string | null;
      }>(
        `SELECT recipient_email_encrypted, recipient_phone_encrypted, recipient_name,
                pgp_sym_decrypt(recipient_email_encrypted, $2) AS decrypted_email,
                pgp_sym_decrypt(recipient_phone_encrypted, $2) AS decrypted_phone
           FROM external_share WHERE id = $1`,
        [v.id, process.env.PII_ENCRYPTION_KEY],
      );
      const row = raw.rows[0]!;
      // Ciphertext present + DISTINCT from plaintext bytes.
      expect(row.recipient_email_encrypted).toBeInstanceOf(Buffer);
      expect(row.recipient_email_encrypted!.toString('utf8')).not.toContain('avi.cohen');
      // Round-trips to the original under the key.
      expect(row.decrypted_email).toBe('avi.cohen@example.com');
      expect(row.decrypted_phone).toBe('0541234599');
      // Name is a label, stored as-is (not PII).
      expect(row.recipient_name).toBe('עו״ד כהן');
    } finally {
      c.release();
    }
  });

  it('absent recipient ⇒ NULL columns + null masked fields (additive/back-compat)', async () => {
    const v = await svc.create(manager(orgA), {
      partyType: 'developer',
      scopeType: 'project',
      scopeIds: [projectAId],
      permissions: {
        overview: { on: true },
        documents: { on: true, actions: { download: true } },
        signatures: { on: true },
      },
      allowSensitive: false,
      otpRequired: true,
    });
    expect(v.recipientName).toBeNull();
    expect(v.recipientEmailMasked).toBeNull();
    expect(v.recipientPhoneMasked).toBeNull();
    expect(v.deliveryChannel).toBe('manual_link'); // safe default
    expect(v.lastDeliveredAt).toBeNull();
  });
});

describe('W-4.1 — party_request who-owes CRUD + partial-unique + RLS', () => {
  it('creates an obligation (open), lists it live, PII-free', async () => {
    const r = await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'appraiser',
      requestedDocType: 'appraisal',
    });
    expect(r.status).toBe('open');
    expect(r.documentParty).toBe('appraiser');
    expect(r.projectId).toBe(projectAId);
    // PII-free: the view has no person fields.
    expect(Object.keys(r)).not.toContain('recipientName');

    const page = await svc.listOpenPartyRequests(manager(orgA), { limit: 25 });
    expect(page.data.some((x) => x.id === r.id)).toBe(true);
  });

  it('REJECTS a second LIVE obligation for the same (project, party, doc-type)', async () => {
    await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'surveyor',
      requestedDocType: 'survey_map',
    });
    await expect(
      svc.createPartyRequest(manager(orgA), {
        projectId: projectAId,
        documentParty: 'surveyor',
        requestedDocType: 'survey_map',
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'duplicate_obligation' } } });
  });

  it('cancel RELEASES the unique slot (status transition; re-open then succeeds)', async () => {
    const first = await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'lawyer',
      requestedDocType: 'regulations',
    });
    const cancelled = await svc.cancelPartyRequest(manager(orgA), first.id);
    expect(cancelled.status).toBe('cancelled');
    // The slot is free again.
    const reopened = await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'lawyer',
      requestedDocType: 'regulations',
    });
    expect(reopened.status).toBe('open');
    expect(reopened.id).not.toBe(first.id);
  });

  it('cancel is idempotent on an already-terminal row', async () => {
    const r = await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'supervisor',
      requestedDocType: 'inspection_report',
    });
    await svc.cancelPartyRequest(manager(orgA), r.id);
    const again = await svc.cancelPartyRequest(manager(orgA), r.id);
    expect(again.status).toBe('cancelled');
  });

  it('allows a TRACK-ONLY obligation for a null-bridge party (municipality)', async () => {
    // The bridge returns null for municipality — a request MAY still be created
    // to TRACK the obligation (4.1 never auto-mints anyway).
    const r = await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'municipality',
      requestedDocType: 'municipal_approval',
    });
    expect(r.status).toBe('open');
    expect(r.documentParty).toBe('municipality');
  });

  it('REJECTS an obligation for a cross-org / unknown project (no oracle)', async () => {
    await expect(
      svc.createPartyRequest(manager(orgA), {
        projectId: projectBId, // org B's project — invisible under org A RLS
        documentParty: 'appraiser',
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'invalid_project' } } });
  });

  it('RLS: org B cannot see or cancel org A obligations', async () => {
    const r = await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'contractor',
      requestedDocType: 'agreement',
    });
    // org B list excludes it.
    const bPage = await svc.listOpenPartyRequests(manager(orgB), { limit: 50 });
    expect(bPage.data.some((x) => x.id === r.id)).toBe(false);
    // org B cancel → generic 404 (no-oracle).
    await expect(svc.cancelPartyRequest(manager(orgB), r.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('suspended org ⇒ create/list/cancel inert (404 / empty)', async () => {
    const r = await svc.createPartyRequest(manager(orgA), {
      projectId: projectAId,
      documentParty: 'other',
      requestedDocType: 'misc',
    });
    await setSuspended(orgA.id, true);
    try {
      await expect(
        svc.createPartyRequest(manager(orgA), {
          projectId: projectAId,
          documentParty: 'other',
          requestedDocType: 'misc2',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      const page = await svc.listOpenPartyRequests(manager(orgA), { limit: 25 });
      expect(page.data).toHaveLength(0);
      await expect(svc.cancelPartyRequest(manager(orgA), r.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    } finally {
      await setSuspended(orgA.id, false);
    }
  });

  it('DELETE on party_request is REVOKED for app_user (cancel is the only removal)', async () => {
    // The app role must NOT hold DELETE — even a direct attempt fails. Verify
    // the grant is absent (information_schema), the structural guarantee.
    const c = await providerPool.connect();
    try {
      const res = await c.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'party_request' AND grantee = 'app_user'`,
      );
      const privs = res.rows.map((r) => r.privilege_type);
      expect(privs).toContain('SELECT');
      expect(privs).toContain('INSERT');
      expect(privs).toContain('UPDATE');
      expect(privs).not.toContain('DELETE');
    } finally {
      c.release();
    }
  });
});

describe('W-4.1 — migration shape sanity (additive, RLS FORCE)', () => {
  it('party_request has RLS enabled + FORCED', async () => {
    const c = await providerPool.connect();
    try {
      const res = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'party_request'`,
      );
      expect(res.rows[0]!.relrowsecurity).toBe(true);
      expect(res.rows[0]!.relforcerowsecurity).toBe(true);
    } finally {
      c.release();
    }
  });

  it('external_share gained the five recipient columns (additive)', async () => {
    const c = await providerPool.connect();
    try {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'external_share'
            AND column_name IN ('recipient_name','recipient_email_encrypted',
              'recipient_phone_encrypted','delivery_channel','last_delivered_at')`,
      );
      expect(res.rows.map((r) => r.column_name).sort()).toEqual(
        [
          'delivery_channel',
          'last_delivered_at',
          'recipient_email_encrypted',
          'recipient_name',
          'recipient_phone_encrypted',
        ].sort(),
      );
    } finally {
      c.release();
    }
  });

  // Touch the imported schema symbols so the spec also guards the Drizzle
  // bindings (compile-time) for both tables.
  it('schema bindings resolve (external_share + party_request)', () => {
    expect(externalShares).toBeTruthy();
    expect(partyRequests).toBeTruthy();
    void and;
    void eq;
  });
});
