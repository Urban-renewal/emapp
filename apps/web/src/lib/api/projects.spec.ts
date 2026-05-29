/**
 * Phase 4a S2 — Project API client surface tests.
 *
 * Pins:
 *  - D.16 envelope unwrapping (data + page; error throws ApiClientError)
 *  - Zod-defensive parsing rejects mis-shaped wire responses
 *  - listProjects builds the correct query string
 *  - archiveProject treats 204 / empty body as success (the api-client
 *    invalid_response branch fires; this client must NOT propagate it)
 *
 * Uses a global `fetch` stub so the api-client → projects layer is
 * exercised end-to-end without actually making network calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiClientError,
  archiveProject,
  createProject,
  getProject,
  listProjects,
} from './projects';

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

const SAMPLE_PROJECT = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  name: 'Test',
  type: 'tama38_2',
  status: 'planning',
  description: null,
  targetSignaturePct: null,
  startedAt: null,
  createdBy: '33333333-3333-3333-3333-333333333333',
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  archivedAt: null,
  // Aggregate stats — list() + get() return ProjectListItem (Project +
  // ProjectStats). The create path parses bare ProjectSchema, which strips
  // these unknown keys, so one fixture serves all call sites.
  buildingsCount: 2,
  unitsCount: 8,
  signaturesPendingCount: 3,
  signaturesSignedCount: 5,
  agentsCount: 1,
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Mark each test as "browser-ish" so api-client's window-event
  // dispatch is exercised on 401 (next test pins that path).
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('listProjects', () => {
  it('1) builds /api/v1/projects?limit=25&cursor=X for a paginated call', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE_PROJECT], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await listProjects({ limit: 25, cursor: 'OPAQUE' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Test');
    expect(result.page).toMatchObject({ limit: 25, cursor: null, has_more: false });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/v1/projects?limit=25&cursor=OPAQUE',
    );
  });

  it('2) builds /api/v1/projects (no query string) when no args', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await listProjects({});
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/v1/projects');
  });

  it('3) throws ApiClientError on a 400 envelope with a specific code', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_cursor' } },
    })) as unknown as typeof fetch;
    await expect(listProjects({ cursor: 'bad' })).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'invalid_cursor',
    });
  });

  it('4) Zod rejects a server response missing required fields (defense in depth)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: {
        data: [{ ...SAMPLE_PROJECT, status: 'NOT_IN_ENUM' }],
        page: { limit: 25, cursor: null, has_more: false },
      },
    })) as unknown as typeof fetch;
    await expect(listProjects({})).rejects.toThrow();
  });
});

describe('getProject', () => {
  it('5) returns the parsed Project on 200 { data }', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: SAMPLE_PROJECT },
    })) as unknown as typeof fetch;
    const p = await getProject(SAMPLE_PROJECT.id);
    expect(p.id).toBe(SAMPLE_PROJECT.id);
  });

  it('6) translates 404 → ApiClientError.code === not_found', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 404,
      body: { error: { code: 'not_found' } },
    })) as unknown as typeof fetch;
    await expect(getProject('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('createProject', () => {
  it('7) POST body is JSON-serialised', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE_PROJECT } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createProject({ name: 'New', type: 'tama38_1' });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"name":"New","type":"tama38_1"}');
  });

  it('8) maps validation_error → ApiClientError with details', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'validation_error', details: { name: ['too short'] } } },
    })) as unknown as typeof fetch;
    try {
      await createProject({ name: '', type: 'tama38_1' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiClientError);
      const err = e as ApiClientError;
      expect(err.code).toBe('validation_error');
      expect(err.details).toEqual({ name: ['too short'] });
    }
  });
});

describe('archiveProject', () => {
  it('9) treats 204 (empty body) as success — no throw', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 204,
      bodyText: '',
    })) as unknown as typeof fetch;
    await expect(archiveProject(SAMPLE_PROJECT.id)).resolves.toBeUndefined();
  });

  it('10) translates a 404 to ApiClientError', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 404,
      body: { error: { code: 'not_found' } },
    })) as unknown as typeof fetch;
    await expect(archiveProject(SAMPLE_PROJECT.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
