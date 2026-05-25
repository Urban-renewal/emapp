/**
 * Perf-5 closure (post-fix audit) — MSW must never be imported by
 * application code. If it were, the mock + msw runtime would ship
 * in the production bundle (~80 KB gzipped). The mocks files in
 * `src/mocks/` are opt-in via `NEXT_PUBLIC_MSW=1` and are bootstrapped
 * by a wiring layer that doesn't exist yet — when it does, that
 * wiring will be the ONLY app-code import of `./mocks/browser`, and
 * the build-time check below ensures every other file stays free of
 * the mocks tree.
 *
 * If you're wiring MSW startup in app code, add the file to
 * `ALLOWED_MSW_IMPORTERS` so this test still passes.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const MOCKS_DIR = join(SRC, 'mocks');

/** Files that are EXPLICITLY allowed to import from `./mocks/*`.
 *  Empty today; populate when the MSW startup wiring lands. */
const ALLOWED_MSW_IMPORTERS: string[] = [];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'mocks') continue;
      yield* walk(full);
    } else if (st.isFile()) {
      const ext = extname(full);
      if (ext === '.ts' || ext === '.tsx') yield full;
    }
  }
}

describe('mocks isolation — Perf-5 closure', () => {
  it('1) no app-code file imports `./mocks/browser` or `./mocks/server` or `msw`', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('.spec.ts')) continue; // tests may import freely
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (ALLOWED_MSW_IMPORTERS.includes(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (
        /from\s+['"]msw['"]|from\s+['"]\S*\/mocks\/(browser|server|handlers|samples)/.test(text)
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('2) src/mocks/ exists (the offline-dev surface is wired up)', () => {
    expect(() => statSync(MOCKS_DIR)).not.toThrow();
  });
});
