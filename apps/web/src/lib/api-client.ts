/**
 * Thin browser-side API client.
 *
 * v8.5 D.35 — Option A topology: the browser ALWAYS calls same-origin
 * `/api/v1/*`. The Pages Function at `src/app/api/[...path]/route.ts`
 * proxies that to the private backend. Net effect:
 *   - cookies are hostOnly on app.emapp.io (no Domain leak)
 *   - no CORS (same origin)
 *   - no browser-exposed backend URL needed (and we deliberately
 *     don't read one — a future hand that added a `NEXT_PUBLIC_*`
 *     hostname env var would break the cookie hostOnly model;
 *     guarded by auth.spec.ts)
 *
 * `credentials: 'same-origin'` is the strictest setting that still
 * sends cookies — it's the right one because we're literally same
 * origin now. ('include' would also work but is the wrong intent.)
 *
 * Phase 4a S1 — mid-session 401 (access token expired, session revoked,
 * refresh failed) fires an `emapp:unauthenticated` window event. The
 * dashboard layout's auth-guard hook listens for it and pushes the
 * user to /login. We dispatch the event from here so every consumer
 * (TanStack Query hooks, plain fetches, mutations) gets the same
 * behaviour without each call site re-implementing the check.
 *
 * Type / helper consolidation: `ApiResponse<T>` + `isOk` come from
 * `@emapp/shared-types` (D.16 envelope SoT). Don't redefine here.
 */
import { type ApiResponse, isOk } from '@emapp/shared-types';

export { isOk };
export type { ApiResponse };

export const UNAUTHENTICATED_EVENT = 'emapp:unauthenticated';

const API_PREFIX = '/api/v1';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  let body: ApiResponse<T>;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    // Non-JSON 5xx body / network garbage — fold into the standard
    // envelope so callers don't have to special-case it.
    body = { error: { code: 'invalid_response', message: 'Non-JSON response body' } };
  }

  if (res.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
  }
  return body;
}

export const apiClient = {
  post: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  get: <T>(path: string) => apiFetch<T>(path, { method: 'GET' }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
