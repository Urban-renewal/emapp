/**
 * §i18n-missing-key family defense.
 *
 * Manual browser smoke caught `/he/signature-requests/new` rendering
 * the raw key `"signatureRequests.createHint"` in place of its hint
 * subtitle. Root cause: the component called `t('createHint')` but the
 * key was never added to `he.json` / `en.json`. next-intl falls back to
 * echoing the key, so the bug is INVISIBLE to TypeScript / lint / unit
 * tests — only a live page render reveals it.
 *
 * This static scanner CATCHES THE FAMILY of bugs (not just the one):
 *
 * Algorithm (single-pass over the FE source tree):
 *  1. For every `.ts` / `.tsx` file under `apps/web/src`:
 *     a. Find `useTranslations('<NS>')` declarations, recording the
 *        alias the developer chose (`t`, `tp`, etc.) → namespace
 *        mapping for that file's scope.
 *     b. Find every `<alias>('<key>')` call (single OR double quoted)
 *        and resolve it to a fully-qualified `<NS>.<key>` reference.
 *  2. Load `messages/he.json` and `messages/en.json`. Walk both into
 *     a flat Set of dotted keys per locale.
 *  3. For each referenced `<NS>.<key>`, assert it exists in BOTH
 *     locales. Missing keys are reported as one consolidated error.
 *
 * False positives this scanner deliberately accepts:
 *  - `t(\`${dynamic}\`)` — template literals with runtime keys are
 *    NOT validatable statically. We skip them. (No occurrences today.)
 *  - `t('field.required')`-style nested keys ARE handled because the
 *    flattener walks recursively.
 *
 * Performance:
 *  - Reading ~120 files + scanning is ~100ms in CI. No I/O outside
 *    `apps/web/src/{app,components,hooks,lib,adapters}` and the two
 *    message JSONs. Bounded; well below the 30s test budget.
 *
 * Threat model linkage (sec/perf/error-handling per CLAUDE.md):
 *  - Security: raw keys leaking on a public-facing page (here: the
 *    sign-link copy view) can betray internal naming to attackers
 *    seeking to fingerprint the app.
 *  - Perf: no runtime cost — pure static analysis at CI time.
 *  - Error handling: failure report is one consolidated list of
 *    `file → key → locales missing`, not 100 separate assertion
 *    failures. Operator-friendly.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname); // apps/web/src
const MESSAGES_ROOT = join(__dirname, 'messages');

/** Subdirectories to scan. Tests / specs are excluded so a spec that
 *  exercises broken keys doesn't trigger the scanner against itself. */
const SCAN_DIRS = ['app', 'components', 'hooks', 'lib', 'adapters'] as const;

/** Walk `dir` recursively and yield every `.ts` / `.tsx` non-spec file. */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      yield* walk(path);
    } else if (
      st.isFile() &&
      (path.endsWith('.ts') || path.endsWith('.tsx')) &&
      !path.endsWith('.spec.ts') &&
      !path.endsWith('.test.ts')
    ) {
      yield path;
    }
  }
}

/** Flatten a nested JSON namespace object to a Set of dotted keys. */
function flatten(obj: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      for (const child of flatten(v, path)) out.add(child);
    } else {
      out.add(path);
    }
  }
  return out;
}

/**
 * Extract `(alias, namespace)` declarations from a file. Supports the
 * two patterns used in the codebase:
 *   const t = useTranslations('owners');
 *   const tp = useTranslations('projects');
 * (any whitespace, both quote styles). Returns Map<alias, namespace>.
 */
function aliasMap(src: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /const\s+(\w+)\s*=\s*useTranslations\(\s*['"]([\w]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    m.set(match[1]!, match[2]!);
  }
  return m;
}

/**
 * Find every `<alias>('<key>')` call. Aliases come from `aliasMap`.
 * Returns Array<{namespace, key, file}> — file is for the error report.
 */
function findCalls(
  src: string,
  aliases: Map<string, string>,
  file: string,
): Array<{ namespace: string; key: string; file: string }> {
  const out: Array<{ namespace: string; key: string; file: string }> = [];
  for (const [alias, namespace] of aliases) {
    // Match `<alias>('key')` with single OR double quotes. The key may
    // contain dots (nested keys), so `[\w.]+`. We deliberately do NOT
    // match template literals or computed keys — those are runtime.
    // eslint-disable-next-line security/detect-non-literal-regexp -- alias is from useTranslations declaration in same file, not user input
    const re = new RegExp(`\\b${alias}\\(\\s*['"]([\\w.]+)['"]\\s*[,)]`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      out.push({ namespace, key: match[1]!, file });
    }
  }
  return out;
}

describe('§i18n-key-coverage — every t(...) reference exists in both locales', () => {
  it('FE source → he.json + en.json: zero missing keys', () => {
    // 1) Load both locale JSONs and flatten to Set<dotted-key>.
    const he = JSON.parse(readFileSync(join(MESSAGES_ROOT, 'he.json'), 'utf8')) as unknown;
    const en = JSON.parse(readFileSync(join(MESSAGES_ROOT, 'en.json'), 'utf8')) as unknown;
    const heKeys = flatten(he);
    const enKeys = flatten(en);

    // 2) Scan every TS/TSX file under the watched subdirs.
    //    Strip block + line comments BEFORE the regex pass so that
    //    documentation referencing dead t('...') calls (e.g. §SEC-M3
    //    in signup/page.tsx explaining why emailTaken was REMOVED)
    //    doesn't false-trigger the scanner. Same comment-stripping
    //    posture as the §P0-4 z.date() scanner.
    const refs: Array<{ namespace: string; key: string; file: string }> = [];
    for (const sub of SCAN_DIRS) {
      const dir = join(SRC_ROOT, sub);
      try {
        statSync(dir);
      } catch {
        continue; // optional dir — skip if missing
      }
      for (const file of walk(dir)) {
        const raw = readFileSync(file, 'utf8');
        const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const aliases = aliasMap(src);
        if (aliases.size === 0) continue;
        for (const ref of findCalls(src, aliases, file)) refs.push(ref);
      }
    }

    // 3) Check each reference exists in BOTH locales.
    //    Path normalisation: handle both POSIX and Windows separators so
    //    the error report is readable on any host. We anchor at the
    //    repo-root `apps/web/src/` segment.
    function relPath(file: string): string {
      const norm = file.replace(/\\/g, '/');
      const i = norm.indexOf('apps/web/src/');
      return i >= 0 ? norm.slice(i) : norm;
    }
    const missingHe: string[] = [];
    const missingEn: string[] = [];
    for (const { namespace, key, file } of refs) {
      const fq = `${namespace}.${key}`;
      const rel = relPath(file);
      if (!heKeys.has(fq)) missingHe.push(`${rel} → ${fq}`);
      if (!enKeys.has(fq)) missingEn.push(`${rel} → ${fq}`);
    }

    // Consolidated error — one assertion failure with the full list,
    // not N separate failures spread across the test reporter.
    expect(
      { missingHe, missingEn },
      `Missing i18n keys:\nHE:\n  ${missingHe.join('\n  ') || '(none)'}\nEN:\n  ${missingEn.join('\n  ') || '(none)'}`,
    ).toEqual({ missingHe: [], missingEn: [] });
  });

  it('he.json and en.json have matching top-level namespace sets', () => {
    // Cheap symmetry check: a namespace declared in one locale but not
    // the other is almost certainly an oversight. Catches "I added an
    // entire new feature's strings to he.json and forgot en.json".
    const he = JSON.parse(readFileSync(join(MESSAGES_ROOT, 'he.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const en = JSON.parse(readFileSync(join(MESSAGES_ROOT, 'en.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const heNs = Object.keys(he).sort();
    const enNs = Object.keys(en).sort();
    expect(heNs).toEqual(enNs);
  });
});

// Silence the unused-import error when MESSAGES_ROOT happens to import dirname.
void dirname;
