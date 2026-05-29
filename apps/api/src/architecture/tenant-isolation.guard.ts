import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Tenant-isolation architecture guard (V12 — the "no honor-system" wall).
 *
 * CLAUDE.md hard rule: "Every DB read goes through withTenant(orgId, fn) or
 * withProvider(...). Direct db.query is FORBIDDEN." Until now that was a NORM
 * — nothing enforced it, so a forgetful/careless change could import the raw
 * `db` client into a NestJS module and silently puncture RLS tenant isolation
 * (an architecture + security regression in one line).
 *
 * This guard turns the norm into a mechanism. It is a RATCHET: it does not
 * claim today's code is perfect — it freezes the current known-good set of
 * module files that legitimately import the raw client (pre-tenant-context
 * auth/OTP flows, audit, etc.) and FAILS the build if any *new* module file
 * imports it. New raw-client access must either use a wrapper, or be a
 * deliberate, reviewed addition to the allowlist (visible in the diff;
 * CODEOWNERS routes apps/api to the owner).
 *
 * Detection signal: a named import of `db`, `providerDb`, or `pool` from
 * `@emapp/db` inside apps/api/src/modules (the business layer). Wrappers and
 * @emapp/db internals are out of scope by construction (this only scans the
 * api module tree).
 */

const RAW_CLIENT_TOKENS = new Set(['db', 'providerDb', 'pool']);

export function findRawClientImporters(modulesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        if (importsRawClient(readFileSync(p, 'utf8'))) {
          out.push(relative(modulesDir, p).split(sep).join('/'));
        }
      }
    }
  };
  walk(modulesDir);
  return out.sort();
}

function importsRawClient(src: string): boolean {
  // Match `import { ... } from '@emapp/db'` (single or multi-line) and check
  // whether any imported binding is a raw-client token.
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]@emapp\/db['"]/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const group = m[1] ?? '';
    const names = group
      .split(',')
      .map((s) => (s.trim().split(/\s+as\s+/)[0] ?? '').trim())
      .filter(Boolean);
    if (names.some((n) => RAW_CLIENT_TOKENS.has(n))) return true;
  }
  return false;
}
