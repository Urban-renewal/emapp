import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * INVARIANT — chain-risk Class 2: SINGLE-SOURCE authorization.
 *
 * The authorization DECISION core (the engine + the guard) must resolve EVERY
 * decision from `role_assignments` — never from the LEGACY JWT `user.role` enum,
 * the legacy `memberships.capabilities` flags, or the dead `policy.ts` oracle.
 *
 * Why this test exists: the slice-5a cutover was a PARTIAL strangler — it added
 * the engine but left the legacy authz in parallel. The places where the two
 * still touch are the chain-risk (they caused the PII split-brain + the Viewer
 * over-reach). This test LOCKS the decision core as legacy-free, so a future
 * change cannot silently re-introduce a legacy read into the gate (a regression
 * to the dual-source state). See docs/CHAIN-RISK-REGISTER.md.
 *
 * SCOPE: the decision core ONLY — `permission.service.ts` (the engine) +
 * `authorization.guard.ts` (the single coarse gate). RECORD-scoping inside
 * services still reads `user.role` (the documented D-D residual that the
 * strangler retires); that is intentionally NOT covered here.
 */
const AUTHZ_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'common', 'authz');

const CORE_FILES = ['permission.service.ts', 'authorization.guard.ts'] as const;

const FORBIDDEN: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /\buser\.role\b/, name: 'user.role (legacy JWT role enum)' },
  { re: /\.role\s*===/, name: '.role === (legacy role-string check)' },
  { re: /\bcapabilities\b/, name: 'memberships.capabilities (legacy D.54 flag)' },
  { re: /from\s+['"][^'"]*\/policy['"]/, name: 'import of policy.ts (the dead oracle)' },
];

/** Strip comments so a doc-comment mention of a legacy term doesn't trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('chain-risk Class 2 — authz decision-core is single-source (engine only)', () => {
  for (const file of CORE_FILES) {
    const code = stripComments(readFileSync(join(AUTHZ_DIR, file), 'utf8'));
    for (const { re, name } of FORBIDDEN) {
      it(`${file} does NOT read ${name}`, () => {
        expect(
          re.test(code),
          `${file} must resolve authorization from role_assignments, not from ${name} ` +
            `(re-introducing this is a regression to the legacy dual-source — see CHAIN-RISK-REGISTER.md)`,
        ).toBe(false);
      });
    }
  }

  it('permission.service.ts DOES resolve from role_assignments (positive control)', () => {
    const code = readFileSync(join(AUTHZ_DIR, 'permission.service.ts'), 'utf8');
    expect(/roleAssignments|role_assignments/.test(code)).toBe(true);
  });
});
