/**
 * Phase 4a S1 guard tests.
 *
 * 1. `API_URL` may NEVER reappear in apps/web source. D.35 mandates a
 *    single env var (`API_BACKEND_URL`) for the backend hostname; any
 *    `process.env['API_URL']` / `process.env.API_URL` is a regression
 *    that re-introduces the old dual-config bug (the FE had a server-
 *    side path bypassing the Pages Function with its own env knob).
 *
 * 2. `NEXT_PUBLIC_API_URL` may NEVER appear in apps/web source. D.35
 *    explicitly forbids exposing the backend URL to the browser
 *    bundle — would break the cookie hostOnly model.
 *
 * The scan is a plain regex over the source tree, NOT a Node `require`
 * walk (would drag transpile deps). Spec files themselves are excluded
 * so the literal regex doesn't false-match.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join } from 'path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      yield* walk(full);
    } else if (st.isFile()) {
      const ext = extname(full);
      if (ext === '.ts' || ext === '.tsx') yield full;
    }
  }
}

function findOccurrences(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    // Exclude all spec files — they're allowed to reference forbidden
    // names as test data (this very file does).
    if (file.endsWith('.spec.ts')) continue;
    const text = readFileSync(file, 'utf8');
    if (pattern.test(text)) hits.push(file);
  }
  return hits;
}

describe('Phase 4a S1 — env-var contract guard', () => {
  it('1) process.env API_URL is never used in apps/web', () => {
    const hits = findOccurrences(/process\.env\s*(?:\[\s*['"]API_URL['"]\s*\]|\.API_URL\b)/);
    expect(hits).toEqual([]);
  });

  it('2) NEXT_PUBLIC_API_URL never appears in apps/web source', () => {
    const hits = findOccurrences(/NEXT_PUBLIC_API_URL/);
    expect(hits).toEqual([]);
  });
});
