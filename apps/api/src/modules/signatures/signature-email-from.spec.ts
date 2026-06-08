/**
 * P6 — branding.senderName wired into the email `From` at the signature SEND
 * SITES. Adversarial, real-DB spec authored by a SEPARATE test author (does NOT
 * trust the builder). Companion to the pure unit suite
 * `packages/db/src/providers/email/email-from.spec.ts` (which proves
 * `buildEmailFrom` in isolation). THIS suite proves the From is actually built
 * from the org's stored `organizations.settings.branding.senderName` and
 * attached at the `email.send(...)` boundary of a real send site — i.e. the
 * sanitization is applied end-to-end, not bypassed.
 *
 * Send site exercised: `SignatureRequestsService.create()` → the resident
 * INVITE email. create() resolves the per-org From via the service's private
 * `resolveFromForOrg(tx, orgId)` (real `getOrgSettings` over real
 * `organizations.settings`) and threads it into `deliverSignatureLink` →
 * `sendInviteEmail` → `email.send({ ..., from })`. We inject a CAPTURING fake
 * IEmailProvider that records every sent `EmailMessage` (incl. `from`), then
 * assert the captured `from`.
 *
 * Harness mirrors signature-requests-resend.spec.ts / -bulk.spec.ts:
 *  - real DB via setupTestDatabase + createTestOrg + providerPool (BYPASSRLS).
 *  - real owner seeded WITH an email so the EMAIL channel fires.
 *  - the per-org `organizations.settings` set via providerPool.
 *
 * NON-VACUITY: the verified ADDRESS is derived at runtime from the imported
 * `DEFAULT_EMAIL_FROM` (NOT hardcoded — EMAIL_FROM may be overridden in env), so
 * tests 1+3 assert the exact `"<senderName> <verified-address>"` the impl must
 * produce. No `eyJ...` literal — the token stub builds a unique token at
 * runtime. CR/LF built at runtime via String.fromCharCode.
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_EMAIL_FROM,
  encryptOwnerPii,
  owners,
  withTenant,
  type EmailMessage,
  type EmailDeliveryResult,
  type IEmailProvider,
} from '@emapp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

// ─── Verified address derived at runtime (NOT hardcoded) ───────────────────
// The impl must keep the From ADDRESS equal to the verified system address,
// whatever EMAIL_FROM resolves to in this env. We parse it out of the imported
// DEFAULT_EMAIL_FROM exactly as the impl's extractAddress does (last <…>, else
// the bare string).
function verifiedAddress(): string {
  const m = /<([^<>]+)>\s*$/.exec(DEFAULT_EMAIL_FROM);
  return (m?.[1] ?? DEFAULT_EMAIL_FROM).trim();
}
const ADDR = verifiedAddress();

// ─── Capturing fake email provider (records EmailMessage incl. `from`) ─────
let captured: EmailMessage[] = [];
const OK: EmailDeliveryResult = { id: 'em-ok', status: 'sent' };
const capturingEmail: IEmailProvider = {
  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    captured.push(message);
    return OK;
  },
  async healthCheck(): Promise<void> {},
};
// Email-channel-only run: an SMS stub that reports sent (owner has a phone too,
// but only the EMAIL message carries the resolved `from`).
const smsStub = {
  send: async () => ({ id: 's-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

// Token stub: unique token each call, built at RUNTIME (no eyJ… literal). The
// token content is irrelevant to From assertions; only its uniqueness matters.
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `tok-${mintCount}-${randomUUID()}`,
      jti: `jti-emailfrom-${mintCount}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  },
} as never;

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;
let projectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000f1';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function natId(): string {
  return String(Math.floor(100000000 + Math.random() * 899999999));
}

/** Seed a real owner WITH an email so the EMAIL channel fires on create(). */
async function seedOwnerWithEmail(orgId: string): Promise<string> {
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

async function seedDoc(orgId: string, project: string, mgrId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'הסכם.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now()) RETURNING id`,
      [orgId, project, `org/${orgId}/doc/${randomUUID()}`, mgrId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Set `organizations.settings` jsonb for this org (BYPASSRLS). Passing a
 *  branding.senderName drives the From display name; `{}` exercises the
 *  default. */
async function setOrgSettings(orgId: string, settings: Record<string, unknown>): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE organizations SET settings = $1::jsonb WHERE id = $2`, [
      JSON.stringify(settings),
      orgId,
    ]);
  } finally {
    c.release();
  }
}

/** Drive the create() send site for a freshly-seeded owner and return the
 *  captured INVITE EmailMessage (exactly one email send per create). */
async function createAndCaptureInvite(docId: string): Promise<EmailMessage> {
  const ownerId = await seedOwnerWithEmail(org.id);
  captured = [];
  const res = await svc.create(manager(), { documentId: docId, ownerId });
  // The email channel must have fired (owner has an email on file).
  expect(res.delivery.email.available).toBe(true);
  expect(captured.length).toBe(1);
  return captured[0]!;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, capturingEmail, smsStub);
  const tag = `sig-emailfrom-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 120_000);

beforeEach(() => {
  captured = [];
});

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('P6 send-site From — invite email via create()', () => {
  it('1) senderName configured → From DISPLAY name applied, ADDRESS unchanged (verified)', async () => {
    await setOrgSettings(org.id, { branding: { senderName: 'Acme Renewal' } });
    const doc = await seedDoc(org.id, projectId, managerId);

    const msg = await createAndCaptureInvite(doc);

    // The captured From is EXACTLY "<senderName> <verified-address>".
    expect(msg.from).toBe(`Acme Renewal <${ADDR}>`);
    // Non-vacuity: the display name is the CONFIGURED senderName…
    expect(msg.from).toContain('Acme Renewal');
    // …and the ADDRESS segment is the verified system address, unchanged.
    expect(msg.from!.slice(msg.from!.lastIndexOf('<'))).toBe(`<${ADDR}>`);
    // Exactly one address segment — senderName did not smuggle a second addr.
    expect((msg.from!.match(/</g) ?? []).length).toBe(1);
    expect((msg.from!.match(/>/g) ?? []).length).toBe(1);
  }, 30_000);

  it('2a) empty settings ({}) → senderName defaults to "EMAPP"; From = "EMAPP <verified>"; email STILL sends', async () => {
    await setOrgSettings(org.id, {}); // → DEFAULT_ORG_SETTINGS → senderName 'EMAPP'
    const doc = await seedDoc(org.id, projectId, managerId);

    const ownerId = await seedOwnerWithEmail(org.id);
    const res = await svc.create(manager(), { documentId: doc, ownerId });

    // The signing flow still succeeds (request created, link returned).
    expect(res.request.id).toBeDefined();
    expect(res.signUrl).toContain('/sign/');
    expect(res.delivery.email.available).toBe(true);
    expect(captured.length).toBe(1);
    // Default org branding senderName is 'EMAPP' → display name 'EMAPP'.
    expect(captured[0]!.from).toBe(`EMAPP <${ADDR}>`);
  }, 30_000);

  it('2b) explicit default-equivalent senderName resolves to the verified default From and STILL sends', async () => {
    // When the senderName equals the default display name, the resolved From is
    // the verified DEFAULT_EMAIL_FROM in display form. The email still sends and
    // the address is the verified one.
    await setOrgSettings(org.id, { branding: { senderName: 'EMAPP' } });
    const doc = await seedDoc(org.id, projectId, managerId);

    const msg = await createAndCaptureInvite(doc);

    expect(msg.from).toBe(`EMAPP <${ADDR}>`);
    expect(msg.from!.slice(msg.from!.lastIndexOf('<'))).toBe(`<${ADDR}>`);
  }, 30_000);

  it('3) header-injection senderName neutralized END-TO-END at the send site (LOAD-BEARING)', async () => {
    // Build the CRLF + Bcc injection at RUNTIME (no raw control bytes in source).
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const evilSenderName = 'Acme' + CR + LF + 'Bcc: attacker@evil.com';
    await setOrgSettings(org.id, { branding: { senderName: evilSenderName } });
    const doc = await seedDoc(org.id, projectId, managerId);

    const msg = await createAndCaptureInvite(doc);
    const from = msg.from!;

    // Proves buildEmailFrom's sanitization is APPLIED at the send site:
    //  - no CR / LF survived (header cannot be split / smuggle a new field)
    expect(from).not.toContain(CR);
    expect(from).not.toContain(LF);
    expect(from.includes('\r')).toBe(false);
    expect(from.includes('\n')).toBe(false);
    //  - no injected header (the `Bcc:` colon is stripped, so the header
    //    keyword cannot reconstitute) and no attacker address leaked
    expect(from.toLowerCase()).not.toContain('bcc:');
    expect(from).not.toContain('attacker@evil.com');
    expect(from).not.toContain('@evil.com');
    //  - the address segment is EXACTLY the verified address (the only @)
    expect(from.slice(from.lastIndexOf('<'))).toBe(`<${ADDR}>`);
    expect((from.match(/</g) ?? []).length).toBe(1);
    expect((from.match(/>/g) ?? []).length).toBe(1);
    // The verified address holds the ONLY `@` and ONLY `:` (the injection's `@`
    // and `:` were stripped, so the surviving display name carries neither).
    const display = from.slice(0, from.lastIndexOf('<')).trimEnd();
    expect(display).not.toContain('@');
    expect(display).not.toContain(':');
    expect(display).not.toContain(CR);
    expect(display).not.toContain(LF);
    // Non-vacuity: the SAFE leading chars survive as the display name (the
    // sanitizer strips specials/controls + collapses whitespace, it does not
    // truncate at the CRLF — so "Acme" leads and "evil.com" lost its `@`).
    expect(display.startsWith('Acme')).toBe(true);
  }, 30_000);

  it('4) best-effort: a corrupt/non-parseable settings value does NOT throw; create succeeds + email sends with the DEFAULT From', async () => {
    // resolveOrgSettings is fail-soft: a malformed branding reverts to the
    // default tree (senderName 'EMAPP'). The create flow must NOT throw and the
    // email must still send. (Belt-and-suspenders for the never-throw contract.)
    await setOrgSettings(org.id, { branding: { senderName: 12345 } }); // wrong type → reverts
    const doc = await seedDoc(org.id, projectId, managerId);

    const ownerId = await seedOwnerWithEmail(org.id);
    // Must resolve, not reject.
    const res = await svc.create(manager(), { documentId: doc, ownerId });

    expect(res.request.id).toBeDefined();
    expect(res.delivery.email.available).toBe(true);
    expect(captured.length).toBe(1);
    // Fell back to the default display name, verified address.
    expect(captured[0]!.from).toBe(`EMAPP <${ADDR}>`);
  }, 30_000);
});

// ─── Test 5 — no token / URL in the From-resolve warn path ─────────────────
//
// The resolve helper (resolveFromForOrg) logs ONLY on a settings-read FAILURE,
// and its warn line must reference the org id only — never a signing URL or
// token. getOrgSettings is itself fail-soft (a bad value can't throw), so to hit
// the catch branch we inject a tx whose settings read REJECTS, and assert the
// warn line carries the org id and nothing token/URL-shaped.
describe('P6 From-resolve warn path — no token/URL in logs', () => {
  it('5) settings-read failure → warn references the org id only (no /sign/ URL, no token)', async () => {
    const warnings: string[] = [];
    // Spy the service Logger.warn for this service instance.
    const probe = new SignatureRequestsService(tokenStub, capturingEmail, smsStub);
    // @ts-expect-error — reach the private logger to capture warn() lines.
    probe.logger = { warn: (m: string) => warnings.push(m), error: () => {} };

    // A fake TenantTx whose settings SELECT rejects → drives the catch branch.
    // The error message is intentionally NEUTRAL (no token/URL): the resolver
    // has NO access to the signing token/URL (those are minted in create()/
    // sign(), not here), so a real failure here cannot carry one. We prove the
    // warn line references only the safe org-id identifier.
    const boomTx = {
      select: () => {
        throw new Error('connection reset by peer');
      },
    } as never;

    // @ts-expect-error — call the private resolver directly with the failing tx.
    const from: string = await probe.resolveFromForOrg(boomTx, org.id);

    // It swallowed the failure and returned the verified default From.
    expect(from).toBe(DEFAULT_EMAIL_FROM);
    // Exactly one warn line, and it carries the org id (the safe identifier)…
    expect(warnings.length).toBe(1);
    const line = warnings[0]!;
    expect(line).toContain(org.id);
    // …but NEVER a signing URL or a JWT-shaped token.
    expect(line).not.toContain('/sign/');
    expect(line).not.toContain('eyJ');
  }, 30_000);
});
