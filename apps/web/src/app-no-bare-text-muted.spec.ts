/**
 * FL-8 §invisible-text-guard — static clean-zero gate.
 *
 * Bans the bare Tailwind utility class `text-muted` used as a TEXT color.
 *
 * ─── WHY (this bug bit TWICE: #437 home, #439 projects/new) ────────────────
 * The EMAPP token set (see `tailwind.config.ts` + `globals.css`) maps:
 *   • `text-muted`            → `--muted`      = hsl(60 4.8% 95.9%) ≈ #f5f5f4
 *                               (a near-WHITE *surface* color — the muted
 *                               background, NOT a foreground). Rendered as a
 *                               TEXT color it produces ~1:1 contrast =
 *                               INVISIBLE text.
 *   • `text-text-muted`       → `--text-muted` = #64748b  (the CORRECT muted
 *                               FOREGROUND / text color).
 *   • `text-muted-foreground` → `--muted-foreground`  (legit — the foreground
 *                               that pairs with the `bg-muted` surface).
 *   • `bg-muted` / `border-muted` (legit — the muted SURFACE itself).
 *
 * So `class="text-muted"` is ALWAYS a bug: it paints near-white text. The
 * correct class is `text-text-muted`. The two existing palette ratchets
 * (`app-no-new-inline-colors`, `app-no-default-palette-class`) do NOT catch
 * this — `text-muted` is a valid EMAPP semantic token (it backs `bg-muted`),
 * so neither ratchet flags it; CI stayed green while the text was invisible.
 * This guard closes that exact gap.
 *
 * ─── CLEAN-ZERO (not a ratchet) ───────────────────────────────────────────
 * Unlike the inline-color / default-palette ratchets, there is NO legitimate
 * bare-`text-muted`-as-text use, so there is no debt to freeze: the gate is
 * a hard zero. Every offender was fixed in the FL-8 slice. If this test fails,
 * you added a bare `text-muted` text utility — change it to `text-text-muted`.
 *
 * ─── PRECISION (what it flags vs what it allows) ──────────────────────────
 * The matcher targets `text-muted` as a STANDALONE class token: bounded by a
 * class-list delimiter on each side (NOT preceded by `[\w-]`, NOT followed by
 * `[\w-]`). Therefore it deliberately does NOT match:
 *   • `text-text-muted`        (correct text color — inner `text-muted` is
 *                               preceded by `-`),
 *   • `text-muted-foreground`  (legit — followed by `-`),
 *   • `bg-muted` / `border-muted` (different prefix — no `text-` to match),
 *   • `var(--text-muted)`      (preceded by `-`),
 *   • the `muted: 'var(--text-muted)'` token DEFINITION in config.
 * Comments are stripped before scanning, so prose/JSDoc that NAMES the class
 * (including this very file's error message) never trips the gate.
 *
 * Same static-guard shape as `app-no-new-inline-colors.spec.ts` and
 * `app-no-default-palette-class.spec.ts`: walk real source, count real
 * occurrences, assert. Scope: `.tsx` + `.ts` under `src/` (excluding specs —
 * a spec may legitimately contain the literal as a fixture, e.g. THIS file).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname);

/**
 * Bare `text-muted` Tailwind class token: not preceded by another word char
 * or `-` (so `text-text-muted`, `--text-muted` never match) and not followed
 * by a word char or `-` (so `text-muted-foreground` never matches). `bg-muted`
 * / `border-muted` lack the `text-` prefix entirely, so they cannot match.
 */
const BARE_TEXT_MUTED = /(?<![\w-])text-muted(?![\w-])/g;

/**
 * Strip `//` line comments and block comments before scanning, so a
 * doc/JSDoc mention of the literal class name (legitimate when explaining
 * the ban) does not count as an offender. JSX strings never contain `//`
 * or block-comment markers around a class name, so this is safe.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function countBareTextMuted(source: string): number {
  return stripComments(source).match(BARE_TEXT_MUTED)?.length ?? 0;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      yield* walk(full);
    } else if (st.isFile() && (extname(full) === '.tsx' || extname(full) === '.ts')) {
      yield full;
    }
  }
}

describe('app components — no bare text-muted text utility (FL-8 invisible-text guard)', () => {
  it('the matcher catches a bare text-muted and ignores the legitimate variants (self-test)', () => {
    // RED on the real bug:
    expect('className="text-sm text-muted"'.match(BARE_TEXT_MUTED)).toHaveLength(1);
    expect('class="text-muted"'.match(BARE_TEXT_MUTED)).toHaveLength(1);
    expect('hover:text-muted'.match(BARE_TEXT_MUTED)).toHaveLength(1);
    // GREEN on every legitimate variant:
    expect('className="text-text-muted"'.match(BARE_TEXT_MUTED)).toBeNull();
    expect('className="text-muted-foreground"'.match(BARE_TEXT_MUTED)).toBeNull();
    expect('className="bg-muted"'.match(BARE_TEXT_MUTED)).toBeNull();
    expect('className="border-muted"'.match(BARE_TEXT_MUTED)).toBeNull();
    expect("style={{ color: 'var(--text-muted)' }}".match(BARE_TEXT_MUTED)).toBeNull();
  });

  it('no source file uses a bare text-muted class (clean zero — use text-text-muted)', () => {
    const perFile: { file: string; count: number }[] = [];

    for (const file of walk(SRC)) {
      if (file.endsWith('.spec.ts') || file.endsWith('.spec.tsx')) continue;
      const count = countBareTextMuted(readFileSync(file, 'utf8'));
      if (count > 0) {
        perFile.push({ file: relative(SRC, file).replace(/\\/g, '/'), count });
      }
    }

    if (perFile.length > 0) {
      const detail = perFile.map((p) => `  ${p.file}: ${p.count}`).join('\n');
      expect.fail(
        'Bare `text-muted` text utility found (FL-8 invisible-text guard).\n' +
          '`text-muted` maps to the near-white --muted SURFACE token, so it ' +
          'renders ~1:1-contrast INVISIBLE text. Use `text-text-muted` (the ' +
          '--text-muted foreground) instead.\n' +
          `offending files:\n${detail}`,
      );
    }

    expect(perFile).toHaveLength(0);
  });
});
