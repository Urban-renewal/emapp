/**
 * E2.0-GUARD §default-palette-leak — static ratchet guard.
 *
 * Companion to `app-no-new-inline-colors.spec.ts`. That ratchet catches
 * inline hex/rgb/hsl literals; this one catches the OTHER token-bypass the
 * visual-system audit named (§1.6 of `docs/design-research/05-visual-system.md`):
 * components reaching straight for Tailwind's **default palette**
 * (`bg-amber-100`, `text-emerald-800`, `bg-red-600`, `text-gray-700`, …).
 *
 * Those classes are NOT part of the EMAPP token set — they map to Tailwind's
 * built-in colors, which are INVISIBLE to a token re-skin or per-org branding.
 * `bg-amber-100` cannot be re-themed from `globals.css`; only the EMAPP
 * semantic classes (`bg-status-warning-bg`, `bg-brand`, `text-text-muted`, …) can.
 * The inline-color ratchet can't see these (they're class names, not literals
 * — see that spec's "honest limits" block), so this guard closes the gap.
 *
 * ─── RATCHET (not a clean-zero gate) ───────────────────────────────────────
 * The tree already contains default-palette leaks (the Provider subtree,
 * status-badge, several list/detail pages). Removing them is OUT OF SCOPE for
 * E2.0 — that is later-slice work (E2.0b re-homes status-badge; the rest
 * follow as each screen is re-skinned). So this guard FREEZES the current
 * count as a baseline and FAILS only if the count INCREASES:
 *   • existing debt is tolerated (build stays green),
 *   • a NEW default-palette class is blocked (build goes red),
 *   • lowering the debt is invited (lower the baseline below).
 *
 * ─── BASELINE — measured across the FULL tree (A8·A9 false-floor guard) ─────
 * Measured 2026-06-19 by scanning EVERY `.tsx` under `src/` (excluding
 * `.spec.tsx`) — the Provider subtree (`provider/backups` 13, `system-health`
 * 12, `tenants/[id]/users` 10, …), every entity "new" page (`members/new` 3),
 * and the settings/member + suspension panels (`member-overrides-panel` 4,
 * `tenant-suspension-panel` 5) ALL included, so the floor is the TRUE count,
 * not a partial-tree under-measure. Original count was 149 across 34 files;
 * E2.0b re-homed `status-badge.tsx` (-8) + `button.tsx` destructive (-2)
 * onto the EMAPP semantic tokens, lowering the floor to 139 occurrences
 * across 32 files (both `components/ui/*` leaks fully retired). THREE E2
 * reskins then re-homed further pages onto the semantic tokens, and their
 * reductions are disjoint so they STACK:
 *   • dashboard-lists slice (#441 — `imports/[id]`, `owners-list`,
 *     `notes-list`, `tasks-list`, `tasks/[id]`),
 *   • ORG-pages slice (#443 — members detail, sig-requests list+detail,
 *     contractors, documents/notes/apartments/buildings detail, projects
 *     sub-pages, member-overrides + owner-pii-reveal panels),
 *   • PROVIDER subtree slice (this branch — 9 files, -66: `provider/backups`
 *     13, `system-health` 12, `tenants/[id]/users` 10, `tenants/[id]` 7,
 *     `provider` home 6, `tenants` 6, `tenant-suspension-panel` 5,
 *     `audit/self` 4, `onboard` 3).
 * With all three merged the baseline below is re-measured on the merged tree
 * (the intersection of every side's still-allowed files). The only remaining
 * default-palette debt is `imports/page.tsx` (the imports LIST page — the
 * `imports/[id]` DETAIL page was retired by #441), so the reconciled floor is
 * **2 occurrences across 1 file**. Ratchets DOWN only.
 *
 * HOW TO LOWER THE BASELINE (do this whenever you re-home a component onto the
 * EMAPP semantic classes): run
 * `pnpm --filter @emapp/web test app-no-default-palette-class` — on a DECREASE
 * the test fails with the new (lower) numbers; copy them into
 * `BASELINE_OCCURRENCES` / `BASELINE_FILES`. The baseline only ratchets DOWN.
 *
 * Scope: component source only — every `.tsx` under `src/` (excluding spec
 * files). `globals.css` / `tailwind.config.ts` (the token DEFINITIONS) are not
 * `.tsx`, so defining a token never trips this guard.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname);

const BASELINE_OCCURRENCES = 2;
const BASELINE_FILES = 1;

/**
 * Default Tailwind palette class: a color-bearing utility prefix
 * (`bg`/`text`/`border`/`ring`/gradient/svg/…) + one of the 22 built-in
 * Tailwind color families + a numeric shade (50 / 100–900 / 950). EMAPP
 * semantic classes (`bg-brand`, `bg-status-warning-bg`, `text-text-muted`,
 * `bg-navy-900`, …) do NOT match — they carry no default-family name with a
 * numeric shade in this exact shape, so they pass cleanly. `\b` boundaries
 * keep it from matching inside longer identifiers. (NB: the muted TEXT color
 * is `text-text-muted`, never bare `text-muted` — that bare class maps to the
 * near-white --muted surface and renders invisible text; it is banned by
 * `app-no-bare-text-muted.spec.ts`.)
 */
const DEFAULT_PALETTE_CLASS =
  /\b(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|shadow|accent|caret|ring-offset)-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|[1-9]00|950)\b/g;

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

function countDefaultPaletteClasses(source: string): number {
  return source.match(DEFAULT_PALETTE_CLASS)?.length ?? 0;
}

describe('app components — no NEW default-palette-class debt (E2.0-GUARD ratchet)', () => {
  it('default Tailwind palette-class count does not exceed the frozen baseline', () => {
    const perFile: { file: string; count: number }[] = [];
    let totalOccurrences = 0;

    for (const file of walk(SRC)) {
      if (file.endsWith('.spec.tsx')) continue;
      const count = countDefaultPaletteClasses(readFileSync(file, 'utf8'));
      if (count > 0) {
        perFile.push({ file: relative(SRC, file).replace(/\\/g, '/'), count });
        totalOccurrences += count;
      }
    }

    const fileCount = perFile.length;

    if (totalOccurrences !== BASELINE_OCCURRENCES || fileCount !== BASELINE_FILES) {
      const direction =
        totalOccurrences > BASELINE_OCCURRENCES || fileCount > BASELINE_FILES
          ? 'INCREASED — you added a default-palette Tailwind class. Use an ' +
            'EMAPP semantic class instead (bg-brand, bg-status-warning-bg, ' +
            'text-text-muted, bg-surface, …). See docs/design-research/05-visual-system.md §1.6/§3.3.'
          : 'DECREASED — debt went down (thank you). Lower ' +
            'BASELINE_OCCURRENCES / BASELINE_FILES in this spec to the new ' +
            'numbers to lock in the win.';
      const detail = perFile.map((p) => `  ${p.file}: ${p.count}`).join('\n');
      expect.fail(
        `Default-palette ratchet tripped (${direction})\n` +
          `  occurrences: ${totalOccurrences} (baseline ${BASELINE_OCCURRENCES})\n` +
          `  files:       ${fileCount} (baseline ${BASELINE_FILES})\n` +
          `current default-palette files:\n${detail}`,
      );
    }

    expect(totalOccurrences).toBe(BASELINE_OCCURRENCES);
    expect(fileCount).toBe(BASELINE_FILES);
  });
});
