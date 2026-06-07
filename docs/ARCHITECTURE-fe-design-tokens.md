# FE design tokens + the re-skin path (honest state + the consolidation that enables per-org branding)

## Honest current state — 4 style layers coexist (presentation-layer debt)

A design-swap analysis surfaced that styling is NOT a single clean layer today:

1. **shadcn CSS vars (HSL)** — component primitives.
2. **partner aliases (hex)** — the design partner's palette.
3. **global classes** (`.btn` / `.card` / `.input` in `globals.css`).
4. **scattered inline** `style={{ color: 'var(--text)' }}` — references tokens (so a
   re-theme STILL propagates) but is less clean and **not 100% consistent** with the classes.

Constraints any new design must honor:

- **RTL-first:** `direction: rtl` + logical properties `ms-*` / `me-*` (never `ml-*`/`mr-*`).
- Because inline ≠ classes aren't fully consistent, a DEEP restyle touches both.

> This is contained to the VIEW layer. The valuable, hard-to-change core — adapters
> (Wire→ViewModel), TanStack hooks, Zod contracts, the `{data}` envelope, services — is
> clean and is preserved across ANY design change (re-theme → new paradigm). The styling
> debt is real but low-risk and local.

## The principle (the SPINE, applied to design): ONE token source of truth

The 4 layers should collapse to: **tokens (single source) → shadcn/component classes
consume tokens → NO ad-hoc inline color/spacing** (inline reserved for genuinely dynamic
values). This is the design-layer version of "policy-as-data, one source" — the same rule
that governs notifications/permissions, applied to visual style.

## Why this is NOT optional hygiene — it ENABLES per-org branding

Per-org **branding** (logo/colors per org — mapped in `ARCHITECTURE-per-org-configurable-
policy.md` §B incremental) is the spine pattern (default + org override). But an org's
palette can only cleanly override if there is ONE token source to override. If colors live
in 4 places, per-org theming is unreliable. **So consolidating the token layers is the
PREREQUISITE for the modular per-org branding goal** — the cleanup is on the path, not a
detour.

## Change-cost (the analysis, confirmed) — view-layer only

- **Re-theme** (new brand palette, same shapes) → swap tokens. Hours, low risk (propagates
  even today because inline refs tokens).
- **Re-style** components/layout → medium, **contained to the view layer** (data untouched).
- **New paradigm** → rebuild the view layer on the SAME data layer.

## Recommended path (endorsed)

1. Bring the new design as **`tokens.css` / Figma-tokens** → map to the `globals.css` token
   vars (establish the ONE source).
2. **Opportunistically consolidate inline-styles → classes** so the 4 layers become just
   {tokens + classes}. Do it as you touch each screen (no big-bang refactor).
3. **THEN per-org branding** = the org's tokens override the defaults (default + override).
4. **RTL audit** any new design for `direction: rtl` + logical properties.
5. **Incremental rollout:** re-theme ONE screen first to validate the token map, then expand.
   The data layer is never touched, so this is safe and reversible.

## Where this sits in the work plan

This is a **DESIGN-TRACK** task — PARALLEL and NON-BLOCKING to the data/feature track
(Feature A, notifications, the per-org spine, the gap-catalog tail), exactly because the
layers are separated. Best executed when the new design tokens arrive: adopt the new tokens
AND consolidate inline→classes in ONE pass per screen. The token consolidation should land
before (or with) the per-org branding feature, since it is that feature's prerequisite.
