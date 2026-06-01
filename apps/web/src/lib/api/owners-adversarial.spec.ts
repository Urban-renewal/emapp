/**
 * AUDIT — adversarial tests for the owners API client + PII discipline.
 *
 * The hostile reviewer's question: can ANY caller of this module
 * accidentally cause PII to leak into a URL, a log, a CustomEvent, or
 * a TanStack queryKey?
 */
import { OwnerSchema } from '@emapp/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { revealOwnerPii, searchOwner } from './owners';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

function jsonResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const SAMPLE_OWNER = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  name: 'דנה כהן',
  email: null,
  nationalIdMasked: '•••••••11',
  phoneMasked: null,
  notes: null,
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  archivedAt: null,
};

describe('searchOwner — PII discipline adversarial', () => {
  it('O1) PII (national_id) is in the REQUEST BODY, never in the URL', async () => {
    const spy = vi.fn(() =>
      Promise.resolve(jsonResp(200, { data: SAMPLE_OWNER })),
    ) as unknown as typeof fetch;
    globalThis.fetch = spy as unknown as typeof fetch;

    await searchOwner({ national_id: '012345678' });

    const url = String(
      (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[0],
    );
    const init = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];

    // URL must NOT contain the digit string
    expect(url).not.toMatch(/012345678/);
    // Body must
    expect(String(init?.body)).toContain('012345678');
    // Must be a POST
    expect(init?.method).toBe('POST');
  });

  it('O2) PII (phone) is in the REQUEST BODY, never in the URL', async () => {
    const spy = vi.fn(() =>
      Promise.resolve(jsonResp(200, { data: SAMPLE_OWNER })),
    ) as unknown as typeof fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    await searchOwner({ phone: '0501234567' });
    const url = String(
      (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[0],
    );
    expect(url).not.toMatch(/0501234567/);
  });

  it('O3) 404 → null (no-oracle: caller cannot distinguish "no such owner" from "not authorized")', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResp(404, { error: { code: 'not_found' } })),
    ) as unknown as typeof fetch;
    const out = await searchOwner({ national_id: '012345678' });
    expect(out).toBe(null);
  });

  it('O4) OwnerSchema rejects a response that includes clear `nationalId` (defense — schema is the wire contract)', () => {
    const malicious = { ...SAMPLE_OWNER, nationalId: '012345678' };
    // .strip is the default — unknown fields are dropped silently.
    // VERIFY: the parsed result does NOT carry the clear value.
    const parsed = OwnerSchema.parse(malicious);
    expect((parsed as unknown as { nationalId?: string }).nationalId).toBeUndefined();
  });

  it('O5) OwnerSchema rejects a response that includes clear `phone`', () => {
    const malicious = { ...SAMPLE_OWNER, phone: '0501234567' };
    const parsed = OwnerSchema.parse(malicious);
    expect((parsed as unknown as { phone?: string }).phone).toBeUndefined();
  });
});

describe('revealOwnerPii — D.54 reveal-on-demand adversarial', () => {
  it('R1) POSTs to /owners/:id/reveal-pii — id in the PATH (not a query string), method POST', async () => {
    const spy = vi.fn(() =>
      Promise.resolve(
        jsonResp(200, {
          data: { id: SAMPLE_OWNER.id, nationalId: '012345678', phone: '0501234567' },
        }),
      ),
    ) as unknown as typeof fetch;
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await revealOwnerPii(SAMPLE_OWNER.id);

    const calls = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const url = String(calls[0]?.[0]);
    const init = calls[0]?.[1];
    expect(url).toContain(`/owners/${SAMPLE_OWNER.id}/reveal-pii`);
    expect(url).not.toContain('?');
    expect(init?.method).toBe('POST');
    // Returns the cleartext for the caller to hold in EPHEMERAL state.
    expect(out.nationalId).toBe('012345678');
    expect(out.phone).toBe('0501234567');
  });

  it('R2) 403 forbidden surfaces as ApiClientError.code (agent without view_owner_pii / viewer)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResp(403, { error: { code: 'forbidden' } })),
    ) as unknown as typeof fetch;
    await expect(revealOwnerPii(SAMPLE_OWNER.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('R3) response schema REQUIRES a 9-digit national_id (a masked/bulleted value is rejected — no silent mask-passthrough)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResp(200, { data: { id: SAMPLE_OWNER.id, nationalId: '•••••••11', phone: null } }),
      ),
    ) as unknown as typeof fetch;
    await expect(revealOwnerPii(SAMPLE_OWNER.id)).rejects.toBeTruthy();
  });
});

describe('Owner wire shape — adversarial schema probes', () => {
  it('O6) wire schema field `nationalIdMasked` is required (cannot be omitted)', () => {
    const r = OwnerSchema.safeParse({ ...SAMPLE_OWNER, nationalIdMasked: undefined });
    expect(r.success).toBe(false);
  });

  it('O7) wire schema accepts arbitrary mask string format (server-controlled — FE does not validate the mask shape)', () => {
    // Two valid masks the server might choose:
    expect(OwnerSchema.safeParse({ ...SAMPLE_OWNER, nationalIdMasked: '•••••••82' }).success).toBe(
      true,
    );
    expect(OwnerSchema.safeParse({ ...SAMPLE_OWNER, nationalIdMasked: '***82' }).success).toBe(
      true,
    );
  });

  it('O8) wire schema phoneMasked accepts null OR a string — the only two legal shapes', () => {
    expect(OwnerSchema.safeParse({ ...SAMPLE_OWNER, phoneMasked: null }).success).toBe(true);
    expect(OwnerSchema.safeParse({ ...SAMPLE_OWNER, phoneMasked: '•••••1234' }).success).toBe(true);
    // numbers/objects must fail
    expect(
      OwnerSchema.safeParse({
        ...SAMPLE_OWNER,
        phoneMasked: 1234 as unknown as string,
      }).success,
    ).toBe(false);
  });

  it('O9) wire schema rejects nationalIdMasked = clear 9 digits (CLOSED §v9-M-4 — MaskedPii regex)', () => {
    const r = OwnerSchema.safeParse({ ...SAMPLE_OWNER, nationalIdMasked: '012345678' });
    expect(r.success).toBe(false);
  });

  it('O9b) MaskedPii requires at least one bullet/asterisk character', () => {
    expect(OwnerSchema.safeParse({ ...SAMPLE_OWNER, nationalIdMasked: '•••••••' }).success).toBe(
      true,
    );
    expect(OwnerSchema.safeParse({ ...SAMPLE_OWNER, nationalIdMasked: '****82' }).success).toBe(
      true,
    );
    expect(OwnerSchema.safeParse({ ...SAMPLE_OWNER, nationalIdMasked: '12345678' }).success).toBe(
      false,
    );
  });
});
