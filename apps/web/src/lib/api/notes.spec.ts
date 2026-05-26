/**
 * Phase 4e — pin the Notes API client surface.
 *
 * Test IDs (D.33 mapping):
 *   T-4e-API.1  list — envelope + cursor
 *   T-4e-API.2  create — POST body + Idempotency-Key
 *   T-4e-API.3  create — 403 forbidden (Viewer) surfaces
 *   T-4e-API.4  update — 403 (non-author + non-Manager) surfaces
 *   T-4e-API.5  update — Zod rejects empty body on the wire
 *   T-4e-API.6  archive — 204 treated as success
 *   T-4e-API.7  archive — 403 surfaces (non-author + non-Manager)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { archiveNote, createNote, getNote, listNotes, updateNote } from './notes';

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

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const SAMPLE = {
  id: NOTE_ID,
  organizationId: '22222222-2222-4222-8222-222222222222',
  projectId: null,
  apartmentId: null,
  body: 'remember to call electrician',
  pinned: false,
  createdBy: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  archivedAt: null,
};

const originalFetch = globalThis.fetch;
beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('listNotes', () => {
  it('T-4e-API.1) builds /notes?limit=25&cursor=X', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE], page: { limit: 25, cursor: 'NEXT', has_more: true } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await listNotes({ limit: 25, cursor: 'OPAQUE' });
    expect(result.items).toHaveLength(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v1/notes?limit=25&cursor=OPAQUE');
  });

  it('T-4e-API.1b) getNote returns parsed Note on 200', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: SAMPLE },
    })) as unknown as typeof fetch;
    const n = await getNote(NOTE_ID);
    expect(n.body).toBe('remember to call electrician');
  });
});

describe('createNote', () => {
  it('T-4e-API.2) POST body + Idempotency-Key', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createNote({ body: 'X' });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"body":"X"}');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-/);
  });

  it('T-4e-API.3) 403 forbidden (Viewer) surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(createNote({ body: 'X' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('updateNote', () => {
  it('T-4e-API.4) 403 (non-author) surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(updateNote(NOTE_ID, { body: 'X' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('T-4e-API.4b) happy path returns updated Note', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: { ...SAMPLE, body: 'updated', pinned: true } },
    })) as unknown as typeof fetch;
    const n = await updateNote(NOTE_ID, { body: 'updated', pinned: true });
    expect(n.body).toBe('updated');
    expect(n.pinned).toBe(true);
  });

  it('T-4e-API.5) Zod rejects validation_error from the BE wire', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'validation_error', details: { body: ['too short'] } } },
    })) as unknown as typeof fetch;
    await expect(updateNote(NOTE_ID, { body: '' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

describe('archiveNote', () => {
  it('T-4e-API.6) 204 (empty body) treated as success', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(archiveNote(NOTE_ID)).resolves.toBeUndefined();
  });

  it('T-4e-API.7) 403 (non-author + non-Manager) surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(archiveNote(NOTE_ID)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
