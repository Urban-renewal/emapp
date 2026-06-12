import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findRawClientImporters } from './tenant-isolation.guard';

const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules');

/**
 * Baseline of module files that legitimately import the raw `@emapp/db`
 * client, as of 2026-05-29. These operate OUTSIDE a tenant RLS context by
 * design (pre-login auth, provider auth, session validity, resident OTP,
 * cross-cutting rate-limit) — so a `withTenant(orgId, …)` wrapper does not
 * apply. This list is a RATCHET baseline, NOT a certification that each is
 * flawless; each remains subject to security review. The guard's job is to
 * block *new* raw-client access, not to bless these.
 *
 * To change this list: removing an entry (you refactored it onto a wrapper)
 * is encouraged — the "stale entry" assertion will remind you. Adding an
 * entry must be a deliberate, reviewed decision (the diff shows it; CODEOWNERS
 * routes apps/api to the owner).
 */
const ALLOWLIST = new Set<string>([
  'auth/auth.service.ts',
  'auth/provider/provider-auth.service.ts',
  'auth/session-validity.ts',
  // 7b-OTP (D-P5.5) — PII step-up unlock. Auth-INFRA tables only
  // (step_up_codes / auth_sessions / users / audit_log-with-explicit-org):
  // session-keyed, no RLS, same posture as the tenant OTP service below.
  // Code hashed at rest; the unlock stamps ONLY the caller's session.
  'auth/step-up.service.ts',
  'auth/tenant/otp.service.ts',
  'export/export-rate-limit.service.ts',
  'portal/portal.service.ts',
]);

describe('architecture: tenant-isolation guard (CLAUDE.md — no direct db outside wrappers)', () => {
  const importers = findRawClientImporters(MODULES_DIR);

  it('no NEW module imports the raw db/providerDb/pool client (use withTenant/withProvider)', () => {
    const unexpected = importers.filter((f) => !ALLOWLIST.has(f));
    expect(
      unexpected,
      `New raw-DB-client import detected in apps/api/src/modules.\n` +
        `These files bypass withTenant/withProvider and can puncture RLS tenant isolation:\n` +
        unexpected.map((f) => `  - ${f}`).join('\n') +
        `\n\nFix: do the DB work inside withTenant(orgId, (tx) => …) / withProvider(...).\n` +
        `If this access is genuinely pre-tenant-context, add it to ALLOWLIST with a reason ` +
        `(reviewed via CODEOWNERS).`,
    ).toEqual([]);
  });

  it('allowlist has no stale entries (refactored files must be removed from it)', () => {
    const stale = [...ALLOWLIST].filter((f) => !importers.includes(f)).sort();
    expect(
      stale,
      `These files are in the tenant-isolation ALLOWLIST but no longer import the raw client.\n` +
        `Remove them from the allowlist to keep the ratchet honest:\n` +
        stale.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([]);
  });
});
