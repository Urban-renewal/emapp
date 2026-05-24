/**
 * Thin browser-side API client.
 *
 * v8.5 D.35 — Option A topology: the browser ALWAYS calls same-origin
 * `/api/v1/*`. The Pages Function at `src/app/api/[...path]/route.ts`
 * proxies that to the private backend. Net effect:
 *   - cookies are hostOnly on app.emapp.io (no Domain leak)
 *   - no CORS (same origin)
 *   - no NEXT_PUBLIC_API_URL needed (and we deliberately don't read
 *     it — a future hand that adds it would break the cookie model)
 *
 * `credentials: 'same-origin'` is the strictest setting that still
 * sends cookies — it's the right one because we're literally same
 * origin now. ('include' would also work but is the wrong intent.)
 */
const API_PREFIX = '/api/v1';

type ApiResponse<T> =
  | { data: T }
  | { error: { code: string; message?: string; details?: unknown } };

async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  const body = (await res.json()) as ApiResponse<T>;
  return body;
}

export function isOk<T>(res: ApiResponse<T>): res is { data: T } {
  return 'data' in res;
}

export const apiClient = {
  post: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) }),

  get: <T>(path: string) => apiFetch<T>(path, { method: 'GET' }),
};
