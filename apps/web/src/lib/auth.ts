'use server';

import { UserProfileSchema, type UserProfile } from '@emapp/shared-types';
import { cookies, headers } from 'next/headers';

export type { UserProfile };

/**
 * Server-side `/me` fetch. Routes through the SAME Pages Function reverse-
 * proxy that the browser uses (D.35) — single env var (`API_BACKEND_URL`),
 * one place where the backend hostname lives. Reads `access_token` from
 * the incoming request's cookie jar (Next App Router Server Component
 * context) and forwards it on the upstream Cookie header.
 *
 * v8.5 follow-up (Phase 4a S1): the older second env-var direct call
 * (read by this module before unification) was inconsistent with D.35
 * and lived behind a separate hostname knob. Unified — only
 * `API_BACKEND_URL` matters now; this function reaches the backend by
 * hitting its own host's `/api/v1/me`, which is routed by
 * `apps/web/src/app/api/[...path]/route.ts`. Guarded by
 * `apps/web/src/lib/auth.spec.ts` (no `process.env` of the legacy name
 * may reappear anywhere in apps/web).
 */
export async function getMe(): Promise<UserProfile | null> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('access_token')?.value;
  if (!accessToken) return null;

  const origin = await selfOrigin();
  if (!origin) return null;

  try {
    const res = await fetch(`${origin}/api/v1/me`, {
      headers: { Cookie: `access_token=${accessToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: unknown };
    const parsed = UserProfileSchema.safeParse(body.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Server Action — revoke the org session in the API and clear cookies.
 * The same-origin proxy passes the upstream `Set-Cookie` clears through;
 * we additionally `cookieStore.delete()` the names locally so the very
 * next render in this same request — before the browser has processed
 * the upstream Set-Cookie — also sees a missing token (defense-in-depth
 * for the middleware-driven /login redirect).
 *
 * Returns `{ ok }` so the caller can show a toast on failure if it wants
 * to; today we treat any failure as "logout still proceeds locally" —
 * worst case the DB session expires on its 30-day TTL.
 */
export async function logout(): Promise<{ ok: boolean }> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('access_token')?.value;
  const origin = await selfOrigin();
  if (!origin) {
    cookieStore.delete('access_token');
    cookieStore.delete('refresh_token');
    return { ok: false };
  }

  let upstreamOk = false;
  try {
    const upstream = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: accessToken ? { Cookie: `access_token=${accessToken}` } : {},
      cache: 'no-store',
    });
    upstreamOk = upstream.ok;
  } catch {
    upstreamOk = false;
  }
  cookieStore.delete('access_token');
  cookieStore.delete('refresh_token');
  return { ok: upstreamOk };
}

async function selfOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get('host');
  if (!host) return null;
  const protocol = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${protocol}://${host}`;
}
