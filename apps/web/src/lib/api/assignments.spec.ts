/**
 * Phase 4c S2 — pin the Project Assignments API client surface.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S2-API.1  list — builds /projects/:id/assignments with cursor
 *   T-4c-S2-API.2  list — empty + no-cursor build
 *   T-4c-S2-API.3  list — invalid_cursor surfaces via ApiClientError
 *   T-4c-S2-API.4  list — Zod rejects mis-shaped (e.g. missing assignedAt)
 *   T-4c-S2-API.5  create — POST body + Idempotency-Key header
 *   T-4c-S2-API.6  create — 409 assignment_exists surfaces
 *   T-4c-S2-API.7  create — 400 invalid_assignee surfaces
 *   T-4c-S2-API.8  create — 403 forbidden surfaces (Agent/Viewer)
 *   T-4c-S2-API.9  unassign — 204 treated as success
 *   T-4c-S2-API.10 unassign — 404 not_found surfaces
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectAssignment,
  listProjectAssignments,
  unassignProjectAssignment,
} from './assignments';
import { ApiClientError } from './errors';

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

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ASSIGNMENT = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: PROJECT_ID,
  userId: '33333333-aaaa-4bbb-8ccc-444444444444',
  roleInProject: 'agent',
  assignedAt: '2026-05-20T10:00:00.000Z',
  unassignedAt: null,
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('listProjectAssignments', () => {
  it('T-4c-S2-API.1) builds /projects/:id/assignments?limit=25&cursor=X', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [ASSIGNMENT], page: { limit: 25, cursor: 'NEXT', has_more: true } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await listProjectAssignments(PROJECT_ID, { limit: 25, cursor: 'OPAQUE' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.userId).toBe(ASSIGNMENT.userId);
    expect(result.page).toMatchObject({ cursor: 'NEXT', has_more: true });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      `/api/v1/projects/${PROJECT_ID}/assignments?limit=25&cursor=OPAQUE`,
    );
  });

  it('T-4c-S2-API.2) builds /projects/:id/assignments (no query string) with no args', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await listProjectAssignments(PROJECT_ID);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`/api/v1/projects/${PROJECT_ID}/assignments`);
  });

  it('T-4c-S2-API.3) throws ApiClientError on 400 invalid_cursor', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_cursor' } },
    })) as unknown as typeof fetch;
    await expect(listProjectAssignments(PROJECT_ID, { cursor: 'bad' })).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'invalid_cursor',
    });
  });

  it('T-4c-S2-API.4) Zod rejects a response missing assignedAt', async () => {
    const broken = { ...ASSIGNMENT } as Record<string, unknown>;
    delete broken['assignedAt'];
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: [broken], page: { limit: 25, cursor: null, has_more: false } },
    })) as unknown as typeof fetch;
    await expect(listProjectAssignments(PROJECT_ID)).rejects.toThrow();
  });
});

describe('createProjectAssignment', () => {
  it('T-4c-S2-API.5) POST body + Idempotency-Key header', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: ASSIGNMENT } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createProjectAssignment(PROJECT_ID, { userId: ASSIGNMENT.userId });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(`{"userId":"${ASSIGNMENT.userId}"}`);
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-/);
  });

  it('T-4c-S2-API.6) 409 assignment_exists surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 409,
      body: { error: { code: 'assignment_exists' } },
    })) as unknown as typeof fetch;
    await expect(
      createProjectAssignment(PROJECT_ID, { userId: ASSIGNMENT.userId }),
    ).rejects.toMatchObject({ code: 'assignment_exists' });
  });

  it('T-4c-S2-API.7) 400 invalid_assignee surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_assignee' } },
    })) as unknown as typeof fetch;
    try {
      await createProjectAssignment(PROJECT_ID, { userId: ASSIGNMENT.userId });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiClientError);
      expect((e as ApiClientError).code).toBe('invalid_assignee');
    }
  });

  it('T-4c-S2-API.8) 403 forbidden surfaces (Agent/Viewer attempting assign)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(
      createProjectAssignment(PROJECT_ID, { userId: ASSIGNMENT.userId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('unassignProjectAssignment', () => {
  it('T-4c-S2-API.9) 204 (empty body) treated as success', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(unassignProjectAssignment(ASSIGNMENT.id)).resolves.toBeUndefined();
  });

  it('T-4c-S2-API.10) 404 not_found surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 404,
      body: { error: { code: 'not_found' } },
    })) as unknown as typeof fetch;
    await expect(unassignProjectAssignment(ASSIGNMENT.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
