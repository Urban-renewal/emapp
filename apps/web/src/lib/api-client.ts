const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';

type ApiResponse<T> =
  | { data: T }
  | { error: { code: string; message?: string; details?: unknown } };

async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    credentials: 'include',
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
