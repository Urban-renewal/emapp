/**
 * AUDIT v1.1 — SA-3: providerUsers.role column is dead; JWT role is hardcoded.
 *
 * **Source:** Security agent #1 (SEC-S4). **Verified at**
 * `apps/api/src/modules/auth/provider/provider-auth.service.ts:247`:
 *
 *   return this.jwt.sign(
 *     { sub, role: 'provider_admin', sid, type: 'provider_access' },
 *     ...
 *
 * **Severity: HIGH** — makes PR #41's new `ProviderAuthorizationGuard`
 * matrix theoretically future-proof but practically inert. An Ops
 * attempt to demote a Provider Admin via `UPDATE provider_users SET
 * role = 'provider_viewer'` has ZERO runtime effect because the JWT
 * issuer ignores the DB column.
 *
 * Closure:
 *   1. `login()` SELECT must include `providerUsers.role`.
 *   2. `role: z.enum(['provider_admin', 'provider_viewer'])` (allowing
 *      only 'provider_admin' today; 'provider_viewer' is a Phase 7
 *      Gate-6 widening).
 *   3. Sign the LOADED role into the JWT.
 *   4. Reject any unknown DB value (defense-in-depth).
 *
 * Ref: AUDIT-V1-1-PHASE6.5-FINDINGS.md §2 SA-3.
 */
import { describe, expect, it } from 'vitest';

describe('AUDIT v1.1 / SA-3 — JWT role must come from DB, not hardcoded (HIGH)', () => {
  // ── CURRENT-STATE pin: source-level assertion the literal is in place
  // This FAILS the moment a closure PR replaces the literal with a
  // variable read from the DB row.
  it('CURRENT-STATE: provider-auth.service.ts hardcodes role:"provider_admin" in signAccess()', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '../auth/provider/provider-auth.service.ts'),
      'utf8',
    );
    // Today this matches at line ~247. The closure PR should make
    // this regex stop matching (because the JWT payload will then
    // be `role: row.role` or similar).
    expect(src).toMatch(/role:\s*['"]provider_admin['"]/);
  });

  // ── POST-FIX (enable after SA-3 closure) ───────────────────────────
  it.todo('POST-FIX: signAccess() takes a `role` parameter loaded from providerUsers row');
  it.todo('POST-FIX: login() SELECT includes providerUsers.role and validates against z.enum');
  it.todo(
    'POST-FIX: UPDATE providerUsers SET role = "provider_viewer" → next login mints viewer JWT',
  );
  it.todo('POST-FIX: an unknown DB role value (corruption / typo) → login rejected loudly');
});
