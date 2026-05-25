/**
 * Phase 4d — pin the Tasks API client surface.
 *
 * Test IDs (D.33 mapping):
 *   T-4d-API.1   list — envelope unwrap + cursor query string
 *   T-4d-API.2   list — no-args build
 *   T-4d-API.3   list — 400 invalid_cursor surfaces
 *   T-4d-API.4   list — Zod rejects bad TaskStatus
 *   T-4d-API.5   create — POST body + Idempotency-Key header
 *   T-4d-API.6   create — 403 forbidden (Agent/Viewer attempting) surfaces
 *   T-4d-API.7   create — validation_error (e.g. title empty) surfaces
 *   T-4d-API.8   update — 403 (Viewer attempting) surfaces
 *   T-4d-API.9   update — Agent updating allowed field (status) — happy path
 *   T-4d-API.10  archive — 204 treated as success; 403 surfaces
 *   T-4d-API.11  addAssignee — 409 assignee_exists surfaces; client-side Zod rejects non-UUID before wire
 *   T-4d-API.12  addAssignee — 400 invalid_assignee surfaces
 *   T-4d-API.13  removeAssignee — 204 treated as success
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addTaskAssignee,
  archiveTask,
  createTask,
  listTaskAssignees,
  listTasks,
  removeTaskAssignee,
  updateTask,
} from './tasks';

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

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SAMPLE_TASK = {
  id: TASK_ID,
  organizationId: '22222222-2222-4222-8222-222222222222',
  projectId: null,
  apartmentId: null,
  title: 'Inspect roof',
  description: null,
  type: 'general',
  status: 'pending',
  priority: 2,
  dueAt: null,
  durationMinutes: null,
  completedAt: null,
  completedBy: null,
  createdBy: USER_ID,
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  archivedAt: null,
};
const SAMPLE_ASSIGNEE = {
  id: '44444444-4444-4444-8444-444444444444',
  taskId: TASK_ID,
  userId: USER_ID,
  assignedAt: '2026-05-21T10:00:00.000Z',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('listTasks', () => {
  it('T-4d-API.1) builds /tasks?limit=25&cursor=X', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE_TASK], page: { limit: 25, cursor: 'NEXT', has_more: true } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await listTasks({ limit: 25, cursor: 'OPAQUE' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Inspect roof');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/v1/tasks?limit=25&cursor=OPAQUE');
  });

  it('T-4d-API.2) no-args build → /tasks (no query string)', async () => {
    const fetchSpy = stubFetch(() => ({
      status: 200,
      body: { data: [], page: { limit: 25, cursor: null, has_more: false } },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await listTasks();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/api/v1/tasks');
  });

  it('T-4d-API.3) 400 invalid_cursor surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_cursor' } },
    })) as unknown as typeof fetch;
    await expect(listTasks({ cursor: 'bad' })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('T-4d-API.4) Zod rejects an unknown TaskStatus', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: {
        data: [{ ...SAMPLE_TASK, status: 'blocked' }],
        page: { limit: 25, cursor: null, has_more: false },
      },
    })) as unknown as typeof fetch;
    await expect(listTasks()).rejects.toThrow();
  });
});

describe('createTask', () => {
  it('T-4d-API.5) POST body + Idempotency-Key', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE_TASK } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await createTask({ title: 'Inspect roof' });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"title":"Inspect roof"}');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-/);
  });

  it('T-4d-API.6) 403 forbidden (Agent/Viewer) surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(createTask({ title: 'X' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('T-4d-API.7) validation_error surfaces (e.g. title empty)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'validation_error', details: { title: ['too short'] } } },
    })) as unknown as typeof fetch;
    await expect(createTask({ title: '' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('updateTask', () => {
  it('T-4d-API.8) 403 forbidden surfaces (Viewer attempting any update)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(updateTask(TASK_ID, { status: 'in_progress' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('T-4d-API.9) Agent updating status — happy path returns updated Task', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: { ...SAMPLE_TASK, status: 'in_progress' } },
    })) as unknown as typeof fetch;
    const t = await updateTask(TASK_ID, { status: 'in_progress' });
    expect(t.status).toBe('in_progress');
  });
});

describe('archiveTask', () => {
  it('T-4d-API.10) 204 treated as success', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(archiveTask(TASK_ID)).resolves.toBeUndefined();
  });

  it('T-4d-API.10b) 403 surfaces on archive (non-Manager)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await expect(archiveTask(TASK_ID)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('assignees', () => {
  it('T-4d-API.11) addAssignee — client-side Zod rejects non-UUID BEFORE wire', async () => {
    const fetchSpy = stubFetch(() => ({ status: 201, body: { data: SAMPLE_ASSIGNEE } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(addTaskAssignee(TASK_ID, { userId: 'not-a-uuid' })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-4d-API.11b) addAssignee — 409 assignee_exists surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 409,
      body: { error: { code: 'assignee_exists' } },
    })) as unknown as typeof fetch;
    await expect(addTaskAssignee(TASK_ID, { userId: USER_ID })).rejects.toMatchObject({
      code: 'assignee_exists',
    });
  });

  it('T-4d-API.12) addAssignee — 400 invalid_assignee surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 400,
      body: { error: { code: 'invalid_assignee' } },
    })) as unknown as typeof fetch;
    await expect(addTaskAssignee(TASK_ID, { userId: USER_ID })).rejects.toMatchObject({
      code: 'invalid_assignee',
    });
  });

  it('T-4d-API.12b) listAssignees — envelope unwrap', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { data: [SAMPLE_ASSIGNEE] },
    })) as unknown as typeof fetch;
    const rows = await listTaskAssignees(TASK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(USER_ID);
  });

  it('T-4d-API.13) removeAssignee — 204 success', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    await expect(removeTaskAssignee(TASK_ID, USER_ID)).resolves.toBeUndefined();
  });

  it('T-4d-API.13b) removeAssignee — 404 not_found surfaces', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 404,
      body: { error: { code: 'not_found' } },
    })) as unknown as typeof fetch;
    await expect(removeTaskAssignee(TASK_ID, USER_ID)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
