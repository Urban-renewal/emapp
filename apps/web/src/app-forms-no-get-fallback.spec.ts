/**
 * P0 §S1-SEC1 closure pin — static source check.
 *
 * Every `<form ...>` element in apps/web/src/app/ MUST carry an
 * explicit `method="post"` attribute. If JS fails to load or hasn't
 * hydrated yet, the browser falls back to native HTML form submission;
 * the default method is GET, which would put every form field
 * (including PII like national_id and credentials like password) in
 * the URL query string — visible in logs, CDN caches, browser
 * history, and Referer headers (Doc 07 §7.10 + Doc 10).
 *
 * react-hook-form's handleSubmit prevents default on the hydrated
 * path, but the SSR HTML lacks both attributes. method="post" is the
 * cheap, mechanical defense that closes the gap.
 *
 * Verification gap closure: §S1-VG1 in OPEN-ITEMS-v9 — the original
 * S1 ship missed this check because RTL synthesized events differently
 * than real browser HTML behavior. This test catches it at the SOURCE
 * (no test-environment quirks).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

import { describe, expect, it } from 'vitest';

const SRC_APP = join(__dirname, 'app');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      yield* walk(full);
    } else if (st.isFile()) {
      const ext = extname(full);
      if (ext === '.tsx') yield full;
    }
  }
}

/**
 * Pull out every <form> tag (single-line or multi-line). We are
 * intentionally generous in matching — any opening `<form` whose
 * attributes (up to the first `>`) lack `method="post"` is a
 * violation. The regex is permissive on whitespace and other attrs.
 */
function findFormsWithoutPostMethod(source: string): string[] {
  const violations: string[] = [];
  const formOpenRegex = /<form\b([^>]*)>/gms;
  let match: RegExpExecArray | null;
  while ((match = formOpenRegex.exec(source)) !== null) {
    const attrs = match[1] ?? '';
    if (!/method\s*=\s*["']post["']/i.test(attrs)) {
      violations.push(match[0].slice(0, 120));
    }
  }
  return violations;
}

describe('app forms — no GET-fallback (P0 §S1-SEC1)', () => {
  it('every <form> in src/app/ has method="post"', () => {
    const offenders: { file: string; form: string }[] = [];
    for (const file of walk(SRC_APP)) {
      if (file.endsWith('.spec.ts') || file.endsWith('.spec.tsx')) continue;
      const text = readFileSync(file, 'utf8');
      const violations = findFormsWithoutPostMethod(text);
      for (const v of violations) {
        offenders.push({
          file: relative(SRC_APP, file).replace(/\\/g, '/'),
          form: v,
        });
      }
    }
    // The failure message lists exactly which file + form-opening
    // tag is missing method="post" — the next agent should add the
    // attribute (see apps/web/src/app/[locale]/(auth)/login/page.tsx
    // for the canonical pattern).
    expect(offenders).toEqual([]);
  });
});
