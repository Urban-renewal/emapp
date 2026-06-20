/**
 * P1-2 §design-token-single-source — static ratchet guard.
 *
 * Canonical color source is `src/app/globals.css` (CSS custom
 * properties) + `tailwind.config.ts` (Tailwind palette mapping).
 * Components MUST consume colors via tokens / Tailwind classes
 * (e.g. `var(--text)`, `text-foreground`, `bg-navy-900`), NEVER via
 * fresh inline hex (`#rgb` / `#rrggbb`), `hsl()`/`hsla()`, or
 * `rgb()`/`rgba()` literals baked into JSX `style={{…}}`, `className`
 * strings, or SVG presentation attributes. New inline color = new
 * design-token debt that breaks the single-source posture and the
 * future per-org re-skin (see `docs/ARCHITECTURE-fe-design-tokens.md`).
 *
 * ─── WHAT THIS GUARD DELIBERATELY DOES NOT CATCH (honest limits) ───
 * Documented after the P1-2 adversarial-probe pass so the next agent
 * isn't lulled into false confidence:
 *   • Bare named CSS colors inline (`color: 'red'`, `'rebeccapurple'`).
 *     Catching these safely needs scoping to a color-property context
 *     (`color:` / `background:` / `stroke=`), which is fragile: a
 *     literal regex for the word "red" would false-positive on prose,
 *     JSDoc, ids, and i18n keys. We accept the gap rather than ship a
 *     guard that flags legitimate code. Functional `rgb()/hsl()` plus
 *     hex cover the overwhelming majority of real inline colors.
 *   • Color literals in `.ts` files (e.g. a `lib/colors.ts` helper).
 *     Scope is `.tsx` only — extending to `.ts` would false-positive
 *     on PR/issue refs in comments (`#118` matches the hex regex). The
 *     one real `.ts` fixture color (`mocks/samples/users.ts` avatar) is
 *     a known, contained exception.
 *   • `.css` / `.module.css` stylesheets — out of scope by design; the
 *     token DEFINITIONS legitimately live in `globals.css`.
 *
 * This is the SAME static-guard pattern as
 * `app-forms-no-get-fallback.spec.ts` — it scans real source files,
 * counts real occurrences, and asserts against a frozen baseline.
 *
 * ─── RATCHET (not a clean-zero gate) ───────────────────────────────
 * Existing components already contain inline colors (4-style-layer
 * debt documented in the architecture doc). Removing them is OUT OF
 * SCOPE for P1-2 — it is the incremental Phase-10 consolidation work.
 * So this guard FREEZES the current count as a baseline and FAILS
 * only if the count INCREASES. Effect:
 *   • existing debt is tolerated (build stays green),
 *   • NEW inline color is blocked (build goes red),
 *   • lowering the debt is invited (lower the baseline below).
 *
 * HOW TO LOWER THE BASELINE (do this whenever you remove an inline
 * color): run `pnpm --filter @emapp/web test app-no-new-inline-colors`
 * — on a DECREASE the test fails with the new (lower) number; copy
 * that number into `BASELINE_OCCURRENCES` (and `BASELINE_FILES` if a
 * whole file went clean). The baseline only ever ratchets DOWN.
 *
 * Scope: component source only — every `.tsx` under `src/` (excluding
 * spec files). The token DEFINITIONS in `globals.css`/`tailwind.config.ts`
 * are the legitimate single source and are NOT scanned (they are not
 * `.tsx`), so defining a token never trips this guard.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname);

/**
 * Frozen baseline — re-measured 2026-06-07 after the P1-2 adversarial
 * probe pass added `rgb()`/`rgba()` to the scan (the original hex+hsl
 * count of 14/7 was blind to ~44 inline `rgba()` literals — 76% of the
 * real debt). True count was 58 inline-color occurrences across 9 files —
 * the two sidebars (pc-sidebar 20, sidebar 13) and tenant portal (13)
 * dominate, plus the login chrome (5), the sign signature-canvas SVG
 * strokes (3), the notifications bell shadow, and members /
 * notifications / projects-new (1 each). The e2 wave-4 c5 re-skin of
 * `projects/new` retired its single inline `#fff` (the stepper bubble
 * moved to the `text-white` class), dropping the floor to **57
 * occurrences across 8 files** (projects/new left the list entirely).
 * Ratchets DOWN only. If you remove an inline color and this test fails
 * with a smaller number, lower these.
 */
const BASELINE_OCCURRENCES = 57;
const BASELINE_FILES = 8;

/** Hex color literal: #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
/** hsl()/hsla() functional-notation literal. */
const HSL_COLOR = /hsla?\([^)]*\)/gi;
/**
 * rgb()/rgba() functional-notation literal. Added after the P1-2
 * adversarial-probe pass (test-author) found the original hex+hsl
 * regex let `rgb(255,0,0)` / `rgba(255,255,255,.10)` slip through —
 * yet the sidebars and tenant/login chrome are FULL of inline rgba()
 * (40+ occurrences). Those are real inline colors and real
 * design-token debt, so they must count toward the ratchet. `rgb(`
 * functional notation is unambiguously a color in source, so this
 * carries near-zero false-positive risk (unlike bare named colors).
 */
const RGB_COLOR = /rgba?\([^)]*\)/gi;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      yield* walk(full);
    } else if (st.isFile() && extname(full) === '.tsx') {
      yield full;
    }
  }
}

/** Count inline hex + rgb/rgba + hsl/hsla color literals in one source file. */
function countInlineColors(source: string): number {
  const hex = source.match(HEX_COLOR);
  const hsl = source.match(HSL_COLOR);
  const rgb = source.match(RGB_COLOR);
  return (hex?.length ?? 0) + (hsl?.length ?? 0) + (rgb?.length ?? 0);
}

describe('app components — no NEW inline-color debt (P1-2 ratchet)', () => {
  it('inline hex/rgb/hsl color count does not exceed the frozen baseline', () => {
    const perFile: { file: string; count: number }[] = [];
    let totalOccurrences = 0;

    for (const file of walk(SRC)) {
      if (file.endsWith('.spec.tsx')) continue;
      const count = countInlineColors(readFileSync(file, 'utf8'));
      if (count > 0) {
        perFile.push({
          file: relative(SRC, file).replace(/\\/g, '/'),
          count,
        });
        totalOccurrences += count;
      }
    }

    const fileCount = perFile.length;

    // INCREASE = new debt → fail with the offending files so the
    // author can switch the literal to a token (`var(--…)`) or a
    // Tailwind class. DECREASE = good → fail too, telling the author
    // to lower the baseline constant (the ratchet tightens).
    if (totalOccurrences !== BASELINE_OCCURRENCES || fileCount !== BASELINE_FILES) {
      const direction =
        totalOccurrences > BASELINE_OCCURRENCES || fileCount > BASELINE_FILES
          ? 'INCREASED — you added an inline hex/hsl color. Use a design ' +
            'token (var(--…)) or a Tailwind class instead. See ' +
            'docs/ARCHITECTURE-fe-design-tokens.md.'
          : 'DECREASED — debt went down (thank you). Lower ' +
            'BASELINE_OCCURRENCES / BASELINE_FILES in this spec to the ' +
            'new numbers to lock in the win.';
      const detail = perFile.map((p) => `  ${p.file}: ${p.count}`).join('\n');
      expect.fail(
        `Inline-color ratchet tripped (${direction})\n` +
          `  occurrences: ${totalOccurrences} (baseline ${BASELINE_OCCURRENCES})\n` +
          `  files:       ${fileCount} (baseline ${BASELINE_FILES})\n` +
          `current inline-color files:\n${detail}`,
      );
    }

    expect(totalOccurrences).toBe(BASELINE_OCCURRENCES);
    expect(fileCount).toBe(BASELINE_FILES);
  });
});
