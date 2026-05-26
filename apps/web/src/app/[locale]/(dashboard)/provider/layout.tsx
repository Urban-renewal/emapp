import { redirect } from 'next/navigation';

import { AccessReasonGate } from '@/components/provider/access-reason-gate';
import { getCurrentSessionUser } from '@/lib/session';

/**
 * Provider Admin route layout — V10-S1 closure (H1 architectural fix).
 *
 * The dashboard layout (parent) has already resolved the session via
 * `getCurrentSessionUser()`. By the time this Server Component runs,
 * one of these is true:
 *  - `session.tier === 'provider'` — the expected path; render the
 *    access-reason gate and let the children mount.
 *  - `session.tier === 'org'` — an org user navigated to /provider/*
 *    DIRECTLY (despite the middleware tier gate; this is a belt-and-
 *    suspenders check in case middleware bypasses ever land — they
 *    shouldn't, but defense in depth costs nothing here). Redirect
 *    to `/` (the locale-aware home; their dashboard layout will
 *    handle it).
 *  - `session === null` — should be impossible (parent already
 *    redirected to /login), but we re-assert and 302 just in case.
 *
 * Why we call `getCurrentSessionUser()` again instead of receiving the
 * session from the parent via React context:
 *  - Server Components can't share context across layout boundaries
 *    without prop drilling or `cache()`-decorated server actions.
 *  - The two calls are cheap — `getMe()` and `getProviderMe()` both
 *    short-circuit on missing cookie. Total cost: ~5ms repeated.
 *  - The duplication is the SAFEST shape: if anyone ever modifies
 *    the dashboard layout to skip the session resolution (or wraps it
 *    in a try/catch that swallows the redirect), this layout still
 *    enforces tier on the provider subtree.
 *
 * AccessReasonGate is unchanged — a Client Component that blocks
 * provider-page rendering until the operator types an investigation
 * reason (sessionStorage; per-tab, not per-browser).
 */
export default async function ProviderLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSessionUser();
  if (!session) redirect('/');
  if (session.tier !== 'provider') redirect('/');

  return <AccessReasonGate>{children}</AccessReasonGate>;
}
