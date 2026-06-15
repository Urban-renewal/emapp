import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Controller-auth architecture guard (Theme-H — the "no honor-system" wall for
 * authentication, the sibling of the tenant-isolation RLS ratchet).
 *
 * Today authentication is applied PER CONTROLLER via a class-level
 * `@UseGuards(AuthGuard, …)`. There is no global default-deny guard (the only
 * APP_GUARD is the throttler), so a NEW domain controller that simply forgets
 * `@UseGuards` ships as a FULLY PUBLIC endpoint — a silent prod exposure that no
 * existing test catches (audit Theme-H).
 *
 * This turns the norm into a mechanism. It is a RATCHET: it freezes the current
 * known set of controllers that have NO class auth guard (the deliberately
 * public surface — OTP, accept-invite, the Prometheus scrape, public signing,
 * each self-authenticating via OTP / a JWT-bearer token / network policy) and
 * FAILS the build if any *new* controller appears without an auth guard. A new
 * unauthenticated controller must either add `@UseGuards(<auth guard>)` or be a
 * deliberate, reviewed addition to the PUBLIC_ALLOWLIST (visible in the diff;
 * CODEOWNERS routes apps/api to the owner).
 *
 * Detection signal: a `@UseGuards(...)` (class or method level) that references
 * any recognised authentication/authorization guard. A controller with no such
 * reference is treated as unauthenticated.
 *
 * SCOPE LIMIT (do NOT over-trust this as a complete auth wall): detection is
 * FILE-LEVEL. A controller is "authenticated" if a recognised guard appears
 * anywhere in the file. This deliberately does NOT catch:
 *   (a) a controller with a class guard but a method that lacks it (partial
 *       coverage), and
 *   (b) the `@Public()` escape hatch — `AuthGuard` short-circuits to allow for
 *       any handler carrying `@Public()` (see auth/guards/auth.guard.ts), so a
 *       `@Public()` method on an otherwise-guarded controller is intentionally
 *       unauthenticated and reads here as "authenticated".
 * This ratchet closes the LARGER hole it targets — a NEW controller that forgets
 * `@UseGuards` ENTIRELY and is silently fully public. A finer, diff-visible
 * ratchet over new `@Public()` additions (so each gets CODEOWNERS review) is a
 * tracked follow-up (Theme-H continuation).
 */

/** Guards that actually AUTHENTICATE (or authorize an authenticated principal).
 *  A controller referencing any of these in a `@UseGuards(...)` is "guarded". */
const AUTH_GUARD_NAMES = [
  'AuthGuard',
  'AuthorizationGuard',
  'TenantGuard',
  'TenantAuthGuard',
  'ContractorAuthGuard',
  'ProviderAuthGuard',
  'ProviderAuthorizationGuard',
] as const;

const AUTH_GUARD_SET: ReadonlySet<string> = new Set(AUTH_GUARD_NAMES);

/** True if the source applies a recognised auth/authz guard via `@UseGuards`. */
export function hasAuthGuard(src: string): boolean {
  const re = /@UseGuards\(([^)]*)\)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Split the @UseGuards(...) args into identifier tokens and check membership
    // (avoids a dynamic RegExp; tokens are exact guard-name matches).
    const tokens = (m[1] ?? '').split(/[^A-Za-z0-9_]+/).filter(Boolean);
    if (tokens.some((t) => AUTH_GUARD_SET.has(t))) return true;
  }
  return false;
}

/** Walk apps/api/src/modules and return the `*.controller.ts` files that have
 *  NO recognised auth guard, as paths relative to `modulesDir` (sorted). */
export function findUnauthenticatedControllers(modulesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) {
        if (!hasAuthGuard(readFileSync(p, 'utf8'))) {
          out.push(relative(modulesDir, p).split(sep).join('/'));
        }
      }
    }
  };
  walk(modulesDir);
  return out.sort();
}
