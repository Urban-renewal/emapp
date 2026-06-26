import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findUnauthenticatedControllers, hasAuthGuard } from './controller-auth.guard';

const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules');

/**
 * Baseline of controllers that DELIBERATELY have no class auth guard, as of
 * 2026-06-14. Each is a genuinely PUBLIC surface that self-authenticates by a
 * mechanism the AuthGuard doesn't model:
 *  - the tenant OTP issue/verify (the SMS code IS the auth);
 *  - the member accept-invite landing (a single-use JWT invite token in the body);
 *  - the Prometheus /metrics scrape (internal; network-restricted, no user auth);
 *  - the public residents' signing surface (`/sign/<jwt>` — the JWT is the bearer).
 *
 * This is a RATCHET baseline, NOT a certification that each is flawless — each
 * remains subject to security review. The guard's job is to block a *new*
 * controller that forgets `@UseGuards`, not to bless these four.
 *
 * To change this list: removing an entry (you added an auth guard) is reminded
 * by the "stale entry" assertion. Adding an entry must be deliberate + reviewed
 * (the diff shows it; CODEOWNERS routes apps/api to the owner).
 */
const PUBLIC_ALLOWLIST = new Set<string>([
  'auth/tenant/otp.controller.ts',
  'members/accept-invite.controller.ts',
  'observability/metrics.controller.ts',
  'signatures/public-sign.controller.ts',
  // DEV-ONLY email-outbox inspector. `@Public()` (developer tool, cross-org by
  // nature) but EACH handler hard-gates on `isDevAuthBypass()` (NODE_ENV===
  // 'development' AND DEV_AUTH_BYPASS==='1') and returns 404 when off, so the
  // route is INVISIBLE in prod (mirrors the /dev-login posture). Belt-and-braces:
  // `getDevEmailOutbox()` is null in prod and `assertDevBypassNotInProduction()`
  // fails boot — so even a gate regression reads nothing. See the controller doc.
  'dev/dev-outbox.controller.ts',
]);

describe('architecture: controller-auth guard (every domain controller is authenticated)', () => {
  const unguarded = findUnauthenticatedControllers(MODULES_DIR);

  it('no controller is unauthenticated unless it is a reviewed public surface', () => {
    const unexpected = unguarded.filter((f) => !PUBLIC_ALLOWLIST.has(f));
    expect(
      unexpected,
      `Controller(s) with NO authentication guard found in apps/api/src/modules.\n` +
        `A controller without @UseGuards(<auth guard>) is a FULLY PUBLIC endpoint:\n` +
        unexpected.map((f) => `  - ${f}`).join('\n') +
        `\n\nFix: add @UseGuards(AuthGuard, …) (+ TenantGuard / AuthorizationGuard as needed).\n` +
        `If it is genuinely a public surface, add it to PUBLIC_ALLOWLIST with a reason ` +
        `(reviewed via CODEOWNERS).`,
    ).toEqual([]);
  });

  it('allowlist has no stale entries (a controller that gained a guard must be removed)', () => {
    const stale = [...PUBLIC_ALLOWLIST].filter((f) => !unguarded.includes(f)).sort();
    expect(
      stale,
      `These controllers are in PUBLIC_ALLOWLIST but now HAVE an auth guard.\n` +
        `Remove them from the allowlist to keep the ratchet honest:\n` +
        stale.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([]);
  });

  // ── teeth: the detector actually distinguishes guarded from unguarded ──
  it('hasAuthGuard detects a recognised auth guard (and ignores a non-auth guard)', () => {
    expect(hasAuthGuard('@UseGuards(AuthGuard, TenantGuard)\nexport class X {}')).toBe(true);
    expect(hasAuthGuard('@UseGuards(ProviderAuthGuard)\nexport class X {}')).toBe(true);
    // No @UseGuards at all → unauthenticated (the honor-system gap).
    expect(hasAuthGuard('@Controller()\nexport class X {}')).toBe(false);
    // A @UseGuards with ONLY a non-auth guard does NOT count as authenticated.
    expect(hasAuthGuard('@UseGuards(SomeRateLimitGuard)\nexport class X {}')).toBe(false);
  });
});
