/**
 * Phase 4c S1 — pin the Member API client surface.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S1-API.1 list — envelope unwrap (data + page) + cursor query string
 *   T-4c-S1-API.2 list — no-arg path (no query string)
 *   T-4c-S1-API.3 list — 400 invalid_cursor → ApiClientError.code
 *   T-4c-S1-API.4 list — Zod rejects mis-shaped response (defense in depth)
 *   T-4c-S1-API.5 create — POST body serialised; Idempotency-Key sent
 *   T-4c-S1-API.6 create — `inviteToken` round-tripped on { data: { member, inviteToken } }
 *   T-4c-S1-API.7 create — prod-shaped response { data: { member } } parses fine (no token)
 *   T-4c-S1-API.8 create — 409 member_exists → ApiClientError.code
 *   T-4c-S1-API.9 patch — body serialised; 400 cannot_remove_last_manager surfaces
 *   T-4c-S1-API.10 patch — 400 cannot_modify_self surfaces
 *   T-4c-S1-API.11 delete — 204 empty body treated as success
 *   T-4c-S1-API.12 acceptInvite — POST body validated client-side (rejects short password BEFORE wire)
 *   T-4c-S1-API.13 acceptInvite — 400 invalid_invite → ApiClientError.code
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPermissionDenied } from '@/components/ui/list-page-shell';

import { ApiClientError } from './errors';
import {
  acceptInvite,
  createMember,
  listMembers,
  revokeMember,
  updateMemberCapabilities,
  updateMemberRole,
} from './members';

interface StubResponse {
  status: number;
  body?: unknown;
  bodyText?: string;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  return vi.fn((url: string, init?: RequestInit) => {
    const r = handler(url, init);
    const text = r.bodyText ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () =>
        text === '' ? Promise.reject(new Error('invalid json')) : Promise.resolve(JSON.parse(text)),
    } as unknown as Response);
  });
}

const SAMPLE_MEMBER = {
  userId: '11111111-1111-1111-1111-111111111111',
  email: 'invitee@alpha.dev',
  name: 'Dana Cohen',
  role: 'agent',
  isPrimary: false,
  invitedBy: '22222222-2222-2222-2222-222222222222',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-05-20T10:00:00.000Z',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('listMembers', () => {
  it('T-4c-S1-API.1) builds /api/v1/members?limit=25&cursor=X', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE_MEMBER], page: { limit: 25, cursor: 'NEXT', has_more: true } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await listMembers({ limit: 25, cursor: 'OPAQUE' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.email).toBe('invitee@alpha.dev');
    expect(result.page).toMatchObject({ limit: 25, cursor: 'NEXT', has_more: true });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v1/members?limit=25&cursor=OPAQUE');
  });

  it('T-4c-S1-API.2) builds /api/v1/members (no query string) with no args', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await listMembers();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/v1/members');
  });

  it('T-4c-S1-API.3) throws ApiClientError on 400 invalid_cursor', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_cursor' } },
    })) as unknown as typeof fetch;
    await expect(listMembers({ cursor: 'bad' })).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'invalid_cursor',
    });
  });

  it('T-4c-S1-API.4) Zod rejects a server response with an unknown role', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: {
        data: [{ ...SAMPLE_MEMBER, role: 'super_admin' }],
        page: { limit: 25, cursor: null, has_more: false },
      },
    })) as unknown as typeof fetch;
    await expect(listMembers()).rejects.toThrow();
  });

  // The members list is Manager/Admin/Owner-only (D.17). A non-Manager who
  // direct-navigates to /members hits a 403 `{ error: { code: 'forbidden' } }`.
  // The list client's error branch keys off `isPermissionDenied(error)` to show
  // the ACCESS-DENIED state (no retry) instead of the generic load-failure
  // banner. These two assertions pin the exact wire→branch contract: the 403
  // becomes an `ApiClientError` whose `code` the shared discriminator accepts.
  it('T-4c-S1-API.4b) 403 forbidden → ApiClientError.code = "forbidden"', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(listMembers()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'forbidden',
    });
  });

  it('T-4c-S1-API.4c) the thrown 403 is classified as a permission denial (access-denied branch)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    const err = await listMembers().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiClientError);
    // The members client renders access-denied (not the retry banner) iff this
    // is true — the same discriminator the audit/projects/owners lists use.
    expect(isPermissionDenied(err)).toBe(true);
    // A genuine load failure (e.g. a 500) must NOT take the access-denied
    // branch — it stays retryable.
    expect(isPermissionDenied(new ApiClientError({ code: 'internal' }))).toBe(false);
  });
});

describe('createMember', () => {
  it('T-4c-S1-API.5) POST body serialised; Idempotency-Key sent', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 201,
      body: { data: { member: SAMPLE_MEMBER, inviteToken: 'JWT.HEADER.SIG' } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createMember({ email: 'x@y.dev', name: 'X Y', role: 'agent' });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"email":"x@y.dev","name":"X Y","role":"agent"}');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-/);
  });

  it('T-4c-S1-API.6) round-trips inviteToken from { data: { member, inviteToken } }', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 201,
      body: { data: { member: SAMPLE_MEMBER, inviteToken: 'HEADER.PAYLOAD.SIG' } },
    })) as unknown as typeof fetch;
    const r = await createMember({ email: 'x@y.dev', name: 'X Y', role: 'agent' });
    expect(r.inviteToken).toBe('HEADER.PAYLOAD.SIG');
    expect(r.member.email).toBe('invitee@alpha.dev');
  });

  it('T-4c-S1-API.7) prod-shaped response { data: { member } } parses fine (inviteToken absent)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 201,
      body: { data: { member: SAMPLE_MEMBER } },
    })) as unknown as typeof fetch;
    const r = await createMember({ email: 'x@y.dev', name: 'X Y', role: 'agent' });
    expect(r.inviteToken).toBeUndefined();
    expect(r.member.email).toBe('invitee@alpha.dev');
  });

  it('T-4c-S1-API.8) 409 member_exists → ApiClientError', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 409,
      body: { error: { code: 'member_exists' } },
    })) as unknown as typeof fetch;
    try {
      await createMember({ email: 'x@y.dev', name: 'X Y', role: 'agent' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiClientError);
      expect((e as ApiClientError).code).toBe('member_exists');
    }
  });
});

describe('updateMemberRole', () => {
  it('T-4c-S1-API.9) PATCH body serialised; 400 cannot_remove_last_manager surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'cannot_remove_last_manager' } },
    })) as unknown as typeof fetch;
    await expect(
      updateMemberRole('33333333-3333-3333-3333-333333333333', { role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'cannot_remove_last_manager' });
  });

  it('T-4c-S1-API.10) 400 cannot_modify_self surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'cannot_modify_self' } },
    })) as unknown as typeof fetch;
    await expect(
      updateMemberRole('33333333-3333-3333-3333-333333333333', { role: 'agent' }),
    ).rejects.toMatchObject({ code: 'cannot_modify_self' });
  });

  it('T-4c-S1-API.10b) happy path returns the updated Member', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: { ...SAMPLE_MEMBER, role: 'manager' } },
    })) as unknown as typeof fetch;
    const m = await updateMemberRole(SAMPLE_MEMBER.userId, { role: 'manager' });
    expect(m.role).toBe('manager');
  });
});

describe('updateMemberCapabilities (D.46/D.54)', () => {
  const FULL = {
    edit_project_data: false,
    manage_documents: true,
    manage_signatures: false,
    manage_tasks: false,
    run_imports: false,
    view_owners: true,
    view_owner_pii: true,
  };

  it('T-D46-API.1) PATCHes /members/:id/capabilities with the body; returns updated Member', async () => {
    let url = '';
    let method = '';
    let sentBody: unknown;
    globalThis.fetch = stubFetch((u, init) => {
      url = u;
      method = init?.method ?? 'GET';
      sentBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return { status: 200, body: { data: { ...SAMPLE_MEMBER, capabilities: FULL } } };
    }) as unknown as typeof fetch;
    const m = await updateMemberCapabilities(SAMPLE_MEMBER.userId, FULL);
    expect(method).toBe('PATCH');
    expect(url).toContain(`/members/${SAMPLE_MEMBER.userId}/capabilities`);
    expect(sentBody).toMatchObject({ manage_documents: true, view_owner_pii: true });
    expect(m.capabilities?.view_owner_pii).toBe(true);
  });

  it('T-D46-API.2) 400 view_owner_pii_requires_view_owners surfaces as ApiClientError.code', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'view_owner_pii_requires_view_owners' } },
    })) as unknown as typeof fetch;
    await expect(
      updateMemberCapabilities(SAMPLE_MEMBER.userId, { view_owner_pii: true, view_owners: false }),
    ).rejects.toMatchObject({ code: 'view_owner_pii_requires_view_owners' });
  });

  it('T-D46-API.3) 400 capabilities_agent_only surfaces (non-agent target)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'capabilities_agent_only' } },
    })) as unknown as typeof fetch;
    await expect(
      updateMemberCapabilities(SAMPLE_MEMBER.userId, { edit_project_data: true }),
    ).rejects.toMatchObject({ code: 'capabilities_agent_only' });
  });

  it('T-D46-API.4) empty body rejected client-side BEFORE the wire (at-least-one-key)', async () => {
    let called = false;
    globalThis.fetch = stubFetch(() => {
      called = true;
      return { status: 200, body: { data: SAMPLE_MEMBER } };
    }) as unknown as typeof fetch;
    await expect(updateMemberCapabilities(SAMPLE_MEMBER.userId, {})).rejects.toBeTruthy();
    expect(called).toBe(false);
  });
});

describe('revokeMember', () => {
  it('T-4c-S1-API.11) 204 (empty body) treated as success — no throw', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(revokeMember(SAMPLE_MEMBER.userId)).resolves.toBeUndefined();
  });

  it('T-4c-S1-API.11b) 400 cannot_remove_last_manager surfaces on revoke', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'cannot_remove_last_manager' } },
    })) as unknown as typeof fetch;
    await expect(revokeMember(SAMPLE_MEMBER.userId)).rejects.toMatchObject({
      code: 'cannot_remove_last_manager',
    });
  });
});

describe('acceptInvite', () => {
  it('T-4c-S1-API.12) rejects a < 12-char password BEFORE the wire (client-side Zod)', async () => {
    const fetchSpy = stubFetch(() => ({ status: 200, body: { data: { ok: true } } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(acceptInvite({ token: 'JWT.HEADER.SIG', password: 'short' })).rejects.toThrow();
    // Critical: no network call was attempted — the Zod parse failed
    // in the client before reaching apiClient.post.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-4c-S1-API.13) 400 invalid_invite surfaces via ApiClientError', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_invite' } },
    })) as unknown as typeof fetch;
    await expect(
      acceptInvite({ token: 'JWT.HEADER.SIG', password: 'long-enough-pass' }),
    ).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('T-4c-S1-API.13b) happy path resolves to { ok: true }', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: { ok: true } },
    })) as unknown as typeof fetch;
    const r = await acceptInvite({ token: 'JWT.HEADER.SIG', password: 'long-enough-pass' });
    expect(r.ok).toBe(true);
  });
});
