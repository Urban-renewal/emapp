# 05 — Visual System & Theming Architecture (EMAPP E2 redesign)

> The visual language + token architecture for the E2 redesign. Goal: **calm,
> warm, trustworthy, professional** for a non-technical Israeli יזם — AND
> **re-skinnable** so the owner's external designer can later change the skin
> (token *values*) without rearchitecting structure, data, or interaction.
>
> Companion docs: `docs/DESIGN-NORTH-STAR.md` (the rubric), `docs/ARCHITECTURE-fe-design-tokens.md`
> (the 4-layer debt + re-skin path), `apps/web/CLAUDE.md` (RTL / Heebo / NameDisplay rules).
> Enforcement: `apps/web/src/app-no-new-inline-colors.spec.ts` (the no-new-inline-color ratchet).
>
> Cited files: `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts`,
> `apps/web/src/components/ui/{button,status-badge,list-page-shell,list-skeleton,name-display}.tsx`.

---

## 0. TL;DR

- The current token system is a **good skeleton but not yet a theming system**.
  It has color, radius, spacing-ish, and Heebo loaded — but it carries the
  documented **4-layer debt** (shadcn HSL · partner hex · global classes ·
  scattered inline) plus a **third, undocumented palette leak**: a few
  components reach straight for Tailwind's *default* palette
  (`bg-amber-100`, `bg-emerald-100`, `bg-red-600`) that is **NOT** part of the
  EMAPP token set and therefore **cannot be re-skinned**. See §1.6.
- The fix is a **3-tier token layering**: `(1) primitive tokens` →
  `(2) semantic aliases` → `(3) components consume only semantic aliases`.
  The designer re-skins by editing tier 1 (and rarely tier 2). Components never
  change. This doc specifies that layering concretely against `globals.css`.
- A proposed **calm/warm visual language**: a single calm primary, semantic
  (not decorative) status colors keyed to the signature-collection domain
  (`success`=past threshold, `warning`=stuck, `danger`=sparingly), a
  Hebrew-first type scale on Heebo @ 400/500/700, generous whitespace, **flat**
  elevation (hairline borders + one whisper shadow), and a small, consistent
  icon set.
- A **component-library spec** for the E2 hero components — stat card,
  progress-with-threshold-marker, triage/action card, project-row, status pill,
  empty/loading/error — each token-driven, RTL-correct (`ms-*`/`me-*`,
  logical insets), a11y-correct (WCAG AA contrast, visible focus ring,
  `<NameDisplay>` bidi rule for every wire-supplied name).
- **Re-skinnability rules** (§5): one source per concept, semantic naming,
  the ratchet stays green, dark-mode + per-org branding fall out of the same
  layering for free.

---

## 1. Audit of the current token system

### 1.1 Color — present, but split across THREE palettes

`globals.css :root` (`apps/web/src/app/globals.css`) declares:

- **shadcn HSL vars** (`--background`, `--foreground`, `--muted`,
  `--muted-foreground`, `--border`, `--primary 172 83% 26%` = teal,
  `--primary-foreground`). These drive `components/ui/*`.
- **Partner semantic aliases** (hex): `--bg-app/-surface/-subtle/-hover`,
  `--border-strong`, `--text/-muted/-soft`, plus ramps `--navy-*`, `--ink-*`,
  `--success-*`, `--warning-*`, `--danger-*`, and `--primary-partner: var(--navy-900)`.

`tailwind.config.ts` **duplicates** the partner ramps as raw hex under
`theme.extend.colors` (`navy`, `ink`, `success`, `warning`, `danger`). The file
header itself flags this as "KNOWN DUPLICATION … must be kept in lock-step."

**Verdict:** color coverage is *complete enough* to theme from (app/surface/
subtle/hover backgrounds, text/muted/soft, border + border-strong, 5 semantic
ramps, two primaries). The problem is **not coverage, it is multiplicity** —
the same logical color is declared in up to three places, and the *primary*
itself is forked: shadcn says teal (`172 83% 26%`), partner says navy
(`--navy-900`). A designer asked to "make the brand color warmer" has to find
and edit it in two unrelated spots and pick which one actually shows.

### 1.2 Spacing — effectively absent as a token scale

There is **no spacing scale token set**. `globals.css` has only `--pad: 16px`
(+ density overrides `compact`/`comfy` that retune `--pad`/`--row-h`), and
`--row-h: 44px`. Everything else uses Tailwind's default spacing utilities
(`p-4`, `gap-3`, `space-y-3`) directly in components. That means **rhythm is not
themeable** — the designer cannot dial "more generous whitespace" globally; they
would have to touch every component. This is the **biggest real gap** versus the
North Star's "generous whitespace / calm" mandate. See §2.4 + §3 for the fix.

### 1.3 Radius — present and coherent

`--r-sm 6 / --r-md 8 / --r-lg 12 / --r-xl 16 / --r-2xl 20` in `globals.css`,
mirrored in `tailwind.config.ts borderRadius` (lg → `var(--radius)` = 0.5rem).
Good. One small inconsistency: `--r-lg = 12px` in globals but Tailwind `lg`
maps to `--radius` (8px). Worth aligning, but minor.

### 1.4 Type scale — partial, not tokenized

Heebo is loaded via `next/font` at **3 weights 400/500/700** (per
`tailwind.config.ts` header + PR #47 LCP note) and exposed as
`font-family: sans → var(--font-heebo)`. But there is **no type-scale token
set** — font sizes are hardcoded per component class (`.btn` 14px,
`.card-hd h3` 15px/700, `.badge` 12px, `.tbl` 13.5px, `.label` 12px) and
elsewhere via Tailwind `text-sm`/`text-xs`. So the type ramp is **not a single
source** and not themeable. A `--card-hd h3` comment in `globals.css` already
admits the 700-vs-600 hierarchy question is unresolved ("Revisit in a dedicated
typography slice"). This redesign **is** that slice.

### 1.5 Elevation — present, flat, good

`tailwind.config.ts boxShadow` defines `xs/sm/md/lg/xl` all using ink rgba
(`rgba(15,23,42,*)`) not black — soft, low-contrast, on-brand for "calm." This
is already aligned with the flat aesthetic we want (§2.5). Keep.

### 1.6 The undocumented gap — components bypassing the token set ⚠️

The `ARCHITECTURE-fe-design-tokens.md` doc lists 4 style layers. Inspecting the
actual `components/ui/*` surfaces a **5th leak the doc does not name**: a few
components use **Tailwind's built-in default palette**, which is *not* the EMAPP
palette and is *invisible* to a token re-skin:

- `components/ui/status-badge.tsx` →
  `bg-gray-100 text-gray-700 / bg-amber-100 text-amber-800 /
  bg-emerald-100 text-emerald-800 / bg-red-100 text-red-800`.
  These are Tailwind defaults (`gray`/`amber`/`emerald`/`red`), **not** the
  EMAPP `ink`/`warning`/`success`/`danger` ramps. Re-skinning the brand will
  leave these status pills untouched — a coherence break.
- `components/ui/button.tsx` → `destructive: 'bg-red-600 text-white'` and
  focus ring `ring-primary` (primary is fine; `red-600` is a default-palette
  leak, parallel to `globals.css .btn-danger` which correctly uses
  `var(--danger-600)`).
- `components/ui/list-skeleton.tsx` uses `bg-muted`/`bg-card`/`border`
  (token-backed — good) — the shimmer is fine.

This leak passes the ratchet (`app-no-new-inline-colors.spec.ts`) because the
ratchet only catches **inline hex/rgb/hsl literals**, not **default-palette
Tailwind class names** (the spec's own "honest limits" block says bare named
colors are out of scope). So `bg-amber-100` is a silent re-skin hole. **The
redesign must route every status color through the EMAPP semantic ramp** (§4.5).

### 1.7 RTL + i18n primitives — solid, reuse as-is

`body { direction: rtl }` (globals.css), `tailwindcss-rtl` plugin, `ms-*`/`me-*`
discipline (`apps/web/CLAUDE.md`), and `<NameDisplay>` (`name-display.tsx`)
bidi-isolation are all in place and correct. The visual system **inherits**
these — every component spec below restates the RTL + NameDisplay obligation
rather than reinventing it.

### Audit scorecard

| Token group | State | Themeable today? | Action |
|---|---|---|---|
| Color | Present ×3 palettes + default-palette leak | Partially | Collapse to one source; kill default-palette leak |
| Spacing | Only `--pad`/`--row-h` | **No** | **Add a real `--space-*` scale** |
| Radius | Present, coherent | Yes | Align `lg` 12 vs 8; keep |
| Type | Heebo loaded; sizes hardcoded | **No** | **Add `--text-*` size/line/weight tokens** |
| Elevation | `xs..xl`, soft ink shadows | Yes | Keep; use sparingly (flat) |
| RTL / bidi | `direction:rtl`, `ms/me`, NameDisplay | Yes | Inherit unchanged |

---

## 2. Proposed visual language

The emotional brief (North Star §"Emotional target"): the יזם opens a screen and
**relaxes**. Calm, warm, reassuring, generous, professional — "the app already
did the thinking." Every choice below serves *relief, not density*.

### 2.1 Color roles — semantic, never decorative

One **calm primary**, a small set of **status roles tied to the signature
domain**, and a quiet neutral spine. Color carries *meaning* only; nothing is
colored for decoration.

| Role | Meaning in EMAPP | Source token (existing ramp) | Notes |
|---|---|---|---|
| **Primary / brand** | Identity, primary actions, active nav, focus ring | resolve the navy-vs-teal fork → pick ONE (`--brand`) | Calm, deep, trustworthy. Navy (`--navy-900 #0b2545`) reads more "real-estate institutional / trust" than teal; recommend navy as `--brand`. Decision belongs to the designer — but it must be **one** token. |
| **Success / past-threshold** | A project crossed the signature **threshold** ("עברנו את הרוב הדרוש"), an owner signed | `--success-*` (`#16a34a`/`#15803d`) | Calm green, used at the *moment of relief*. Never as generic "on" color. |
| **Warning / stuck** | No movement N days, "תקוע", reminder overdue, approaching expiry | `--warning-*` (`#d97706`/`#b45309`) | Amber = "needs a nudge", not failure. The dominant attention color in triage. |
| **Danger** (sparingly) | Destructive/irreversible (archive-with-data-loss, delete), hard failure (expired, rejected) | `--danger-*` (`#dc2626`/`#b91c1c`) | Reserve for genuinely destructive or terminal. A stuck signature is **warning**, not danger — over-red feels alarming and breaks "calm." |
| **Info / neutral status** | Planning, draft, informational | `--navy-50/100` (info badge) or `--ink-*` | Quiet. |
| **Text** | foreground / secondary / tertiary | `--text` / `--text-muted` / `--text-soft` | 3-step text hierarchy already exists — keep, use *only* these 3. |
| **Surfaces** | app bg / card / subtle / hover | `--bg-app/-surface/-subtle/-hover` | Warm-neutral, not pure cold white. |

> **Warmth knob.** Today `--bg-app #f5f7fa` and text `#0f172a` are cool slate.
> To hit "warm + reassuring" without a redesign, the designer nudges
> `--bg-app`/`--bg-surface` a few degrees toward warm-neutral (e.g. a hair of
> warmth, paper-like off-white) and softens pure-black text to the existing
> `--text #0f172a` (already not #000 — good). This is a **token-value** change,
> exactly the re-skin surface we are building for. The *system* doesn't change.

### 2.2 Type scale — Hebrew-first, on Heebo

Heebo @ 400/500/700 (already loaded — do not add weights; PR #47 LCP). Hebrew
has **no case and no italics**, so hierarchy comes from **size + weight +
color**, never from ALL-CAPS or italic. Propose a tokenized ramp
(see §3 for the token form):

| Token | px / line-height | Weight | Use |
|---|---|---|---|
| `--text-display` | 28 / 36 | 700 | The one big "where you stand" number / page hero |
| `--text-title` | 20 / 28 | 700 | Section + card titles (replaces ad-hoc `.card-hd h3` 15/700) |
| `--text-subtitle` | 16 / 24 | 500 | Sub-headers, the plain-Hebrew "why" sentence |
| `--text-body` | 14 / 22 | 400 | Default body, table cells |
| `--text-label` | 13 / 18 | 500 | Field labels, badge text, meta |
| `--text-caption` | 12 / 16 | 400 | Timestamps, fine print, `--text-soft` |

Rules: **numbers use `font-variant-numeric: tabular-nums`** (the `.tabular`
utility already exists) so counts/percentages don't jitter. Hebrew body sits
comfortably at 14–16px; do **not** go below 12px for Hebrew (legibility). Weight
500 is the "calm emphasis" — prefer it over 700 for most emphasis so the page
stays soft; reserve 700 for the single hero number and titles.

### 2.3 Tone & voice surfacing (visual side of "plain Hebrew")

North Star principle 2 ("plain Hebrew, zero jargon") is mostly copy, but the
visual system supports it: **words lead, numbers serve**. Concretely —
a stat card shows the *sentence* ("כמעט שם · חסרה חתימה אחת") as the primary
(`--text-subtitle`), and the metric (`64%`) as secondary/`--text-muted`. The
type scale (§2.2) deliberately gives the sentence more visual weight than the
number. The system never renders a bare metric as a hero.

### 2.4 Spacing rhythm — generous, 4px base

Introduce a real scale (the §1.2 gap). 4px base, geometric-ish:

`--space-1 4 · --space-2 8 · --space-3 12 · --space-4 16 · --space-5 20 ·
--space-6 24 · --space-8 32 · --space-10 40 · --space-12 48`.

Calm = **breathe**. Defaults for the redesign: card padding `--space-5` (20),
gaps between cards `--space-4`/`--space-6`, page gutter `--space-6`+, section
spacing `--space-8`. The existing `--pad 16` becomes `--space-4`; density modes
(`compact`/`comfy`) retune the *scale base* or `--pad` alias, so density still
works. The designer dials whitespace globally by editing these tokens.

### 2.5 Radius & elevation — soft, flat

- **Radius:** keep the `--r-*` ramp. Cards `--r-lg` (12), inputs/buttons
  `--r-md` (8), pills 999px, modals `--r-xl`. Soft but not bubbly.
- **Elevation: flat.** Calm ≠ floating cards. Default card =
  **hairline border (`1px var(--border)`) + at most `shadow-xs`** (the existing
  `0 1px 2px rgba(15,23,42,.04)`). Reserve `shadow-md`/`lg` for genuinely
  floating layers (dropdown, popover, modal). No drop-shadow stacks, no glows.
  This already matches `.card` in `globals.css` — keep it, don't escalate.

### 2.6 Iconography

- One library, **outline / stroked** (lucide-react is the shadcn default;
  confirm and standardize). Stroke icons read calmer than filled.
- Default size 20px (inline 16px), stroke ~1.75. Icon color **inherits
  `currentColor`** → it themes for free (never hardcode an icon color).
- Icons are **supportive, not decorative**: a status pill may carry a tiny dot
  (the existing `.badge-dot`) rather than a loud icon. Don't icon-spam a calm UI.
- **RTL:** directional icons (chevron/arrow "next/back") must mirror. Use
  logical direction (the `tailwindcss-rtl` plugin) or swap the glyph by
  `dir`; never hardcode a left-pointing chevron for "forward."

### 2.7 Motion

Keep the existing `tailwind.config.ts` keyframes (`fade-in` .18s,
`slide-up` .22s, `scale-in` .18s) — short, ease-out, **calm**. Use for
enter transitions and the triage list settling. Honor
`prefers-reduced-motion` (gate the animation classes). No bouncy/spring,
no attention-grabbing pulses except the loading shimmer.

---

## 3. Theming architecture — the 3-tier layering

The single goal: **the designer re-skins by editing Tier 1 token *values*; no
component file changes.** Structure `globals.css` into three explicit tiers.

```
TIER 1 — PRIMITIVE TOKENS  (the raw scales; the designer's editing surface)
   --navy-900, --ink-500, --success-600, --space-4, --r-lg,
   --text-title-size, Heebo … pure values, no meaning.

         ▼ referenced by

TIER 2 — SEMANTIC ALIASES  (roles; the stable contract)
   --brand, --brand-fg, --surface, --surface-subtle, --text, --text-muted,
   --status-success-bg/-fg, --status-warning-bg/-fg, --status-danger-bg/-fg,
   --space-card, --radius-card, --focus-ring …
   Each = var(<a Tier-1 token>). Meaning lives here, values do not.

         ▼ consumed by (ONLY this layer)

TIER 3 — COMPONENTS  (button, card, stat-card, progress, badge, …)
   Consume ONLY Tier-2 semantic aliases (via Tailwind classes that map to
   them, or var(--semantic) in the component class). NEVER a Tier-1 ramp
   step directly, NEVER a raw hex, NEVER a Tailwind default-palette class.
```

### 3.1 Why three tiers (not the current two)

Today `globals.css` already has primitives (`--navy-*`) **and** some semantic
aliases (`--text`, `--bg-surface`) — but components reach into **both** layers
inconsistently (`var(--text)` here, `var(--navy-900)` there, `bg-amber-100`
elsewhere). The fix is the **discipline that components touch ONLY Tier 2.**
Then:

- **Re-skin** = edit Tier 1 (and, rarely, re-point a Tier-2 alias to a
  different ramp). One file, low risk — matches the
  `ARCHITECTURE-fe-design-tokens.md` "swap tokens, hours, low risk" path.
- **Per-org branding** = an org overrides a handful of Tier-1/Tier-2 vars on a
  scoped root (the doc's "default + override" spine). Only works if there's one
  source — this layering *is* the prerequisite the architecture doc names.
- **Dark mode** = the existing `.dark` block re-points Tier-2 aliases. Free.

### 3.2 Concrete additions to `globals.css`

Add a **Tier-2 semantic block** under `:root` (additive — does not break the
shadcn HSL or partner-hex layers, which become Tier 1 sources). Illustrative:

```css
:root {
  /* ── TIER 2: SEMANTIC ALIASES (the contract components consume) ── */

  /* brand — resolve the navy/teal fork to ONE source */
  --brand:        var(--navy-900);   /* recommend navy; designer's call */
  --brand-hover:  var(--navy-800);
  --brand-fg:     #ffffff;           /* AA on navy-900 — verify per §4.7 */
  --focus-ring:   var(--navy-500);

  /* surfaces & text — already semantic, formalize as Tier 2 */
  --surface:        var(--bg-surface);
  --surface-subtle: var(--bg-subtle);
  --surface-app:    var(--bg-app);
  --surface-hover:  var(--bg-hover);
  /* --text / --text-muted / --text-soft already exist — keep as Tier 2 */

  /* status — the ONE place status color is defined; kills the
     status-badge.tsx default-palette leak (§1.6) */
  --status-success-bg: var(--success-50);  --status-success-fg: var(--success-700);
  --status-warning-bg: var(--warning-50);  --status-warning-fg: var(--warning-700);
  --status-danger-bg:  var(--danger-50);   --status-danger-fg:  var(--danger-700);
  --status-info-bg:    var(--navy-50);     --status-info-fg:    var(--navy-800);
  --status-neutral-bg: var(--ink-100);     --status-neutral-fg: var(--ink-700);

  /* spacing — NEW scale (§2.4); fills the §1.2 gap */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px; --space-12:48px;
  --space-card: var(--space-5);
  --pad: var(--space-4);            /* back-compat alias */

  /* type — NEW size/line tokens (§2.2); fills the §1.4 gap */
  --text-display-size:28px; --text-display-lh:36px;
  --text-title-size:20px;   --text-title-lh:28px;
  --text-subtitle-size:16px;--text-subtitle-lh:24px;
  --text-body-size:14px;    --text-body-lh:22px;
  --text-label-size:13px;   --text-label-lh:18px;
  --text-caption-size:12px; --text-caption-lh:16px;
  --weight-regular:400; --weight-medium:500; --weight-bold:700;

  /* radius — alias to the existing --r-* ramp */
  --radius-card: var(--r-lg); --radius-control: var(--r-md); --radius-pill:999px;
}
```

### 3.3 Concrete additions to `tailwind.config.ts`

So components author in Tailwind (the team's idiom) but every utility resolves
to a **semantic** token — never a Tier-1 ramp or a default:

- **`colors`**: add semantic entries that map to Tier-2 vars, e.g.
  `brand: 'var(--brand)'`, `'brand-fg': 'var(--brand-fg)'`,
  `surface: { DEFAULT:'var(--surface)', subtle:'var(--surface-subtle)', … }`,
  `status: { 'success-bg':'var(--status-success-bg)', … }`. Keep the existing
  `navy`/`ink`/`success`/… ramps but **treat them as Tier 1 — components stop
  using them directly** (lint/review rule, §5).
  > Migration note: the current ramps are raw hex duplicated from globals.
  > The architecture doc's planned move is to rebase them onto `hsl(var(--…))`.
  > Adding the **semantic** layer above them is the higher-leverage step and
  > can land first; rebasing the ramps is the existing follow-up.
- **`spacing`**: extend with `1:'var(--space-1)' … 12:'var(--space-12)'`,
  `card:'var(--space-card)'` so `p-card`, `gap-6`, `space-y-8` are tokenized.
- **`fontSize`**: add `display/title/subtitle/body/label/caption` mapped to the
  `--text-*` size+lh tokens (Tailwind supports `['size',{lineHeight}]`).
- **`borderRadius`**: add `card/control/pill` → the radius aliases.
- **`ringColor` default / focus**: `ring-[color:var(--focus-ring)]` or a named
  `ring-focus`. Button already uses `ring-primary` — re-point to the brand
  semantic so focus themes with brand.

### 3.4 The result

A component is authored as `bg-surface p-card rounded-card text-body shadow-xs
border border-border` and a status pill as `bg-status-warning-bg
text-status-warning-fg`. **Zero** Tier-1 ramp references, zero default-palette
classes, zero inline hex. Re-skin = edit `globals.css` Tier 1. Done.

---

## 4. Component-library spec (E2 hero components)

Each spec: token-driven structure, RTL, a11y. **Global obligations for every
component** (stated once, apply to all):

- **RTL:** logical properties only — `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/
  `end-*`, `text-start`/`text-end`. Never `ml/mr/left/right`. Inherit
  `direction: rtl` from `body`.
- **Bidi (§v9-H-3):** every name/string that originated from a user or the wire
  (owner name, project name, tenant-typed text) renders inside `<NameDisplay>`
  (`components/ui/name-display.tsx`). Hard-coded i18n labels do **not** need it.
- **Color:** only Tier-2 semantic tokens / the Tailwind semantic classes from
  §3.3. No hex, no `rgb()/hsl()` (ratchet), no default-palette class (§1.6).
- **a11y:** WCAG **AA** contrast (§4.7), a visible focus ring
  (`ring-2 ring-focus`), `aria-*` where state is conveyed by color alone, and a
  text/icon label alongside any color-coded status (color is never the *only*
  signal — colorblind + "calm, never alarming").

### 4.1 Stat card (`StatCard`)

The home "pulse" tile (North Star: a short pulse, words over numbers).

- **Structure:** `bg-surface rounded-card border border-border shadow-xs
  p-card`. A small `--text-label` eyebrow (the metric name), then the **hero
  number** `--text-display` `tabular-nums`, then a **plain-Hebrew sentence**
  `--text-subtitle text-muted` (the "why"). Optional trend chip
  ("+2 השבוע" success / "אין תנועה 18 יום" warning) using the status tokens.
- **Words-over-numbers (§2.3):** if the card is a *triage* signal, the sentence
  is primary and the number secondary. If it's a pure KPI pulse, the number
  leads. Never a bare number with no label.
- **RTL/a11y:** eyebrow `text-start`; trend chip on the `end` side
  (`ms-auto`). Number is `tabular-nums` so it doesn't jump. If the card is a
  link, the whole card is one focusable target with a visible ring.

### 4.2 Progress with threshold marker (`ThresholdProgress`)

The signature-collection signal — % signed vs the **required threshold** (the
domain's defining mechanic; "past the threshold" is the moment of relief).

- **Structure:** extend the existing `.progress` (`globals.css`) — a track
  (`bg-ink-100` → re-token to `--surface-subtle`/a neutral track token), a fill
  `var(--brand)`, and a **threshold marker**: a 2px vertical rule at the
  required-% position (`--text-soft`/border-strong), with an accessible label
  ("רוב דרוש: 66%").
- **Color logic (semantic):** fill is **brand/neutral while below** threshold,
  flips to **`--status-success`** the instant it crosses (relief). If the
  project is *stuck* near but below threshold, the surrounding card — not the
  bar — carries the `warning` cue. The bar shows progress; the card shows mood.
- **RTL:** the bar **fills from the right** (start). With `direction: rtl` a
  `width:%` fill from the inline-start does this automatically; verify the
  threshold marker uses `inset-inline-start`, not `left`.
- **a11y:** `role="progressbar"` + `aria-valuenow/min/max` +
  `aria-valuetext="32 מתוך 50 חתמו · עברו את הרוב הדרוש"`. Never communicate
  "past threshold" by color alone — include the words.

### 4.3 Triage / action card (`ActionCard`)

The heart of the home — the ~5 projects that **need you now** (North Star
principle 3 + 4). One card = one project that needs action + the human "why."

- **Structure:** `bg-surface rounded-card border border-border p-card`, generous
  `--space-4` internal gaps. Layout (RTL, start→end): project name
  (`<NameDisplay>`, `--text-title`) → the plain-Hebrew situation sentence
  (`--text-subtitle text-muted`, e.g. "אורי דירה 7 לא חתם · 18 יום ללא תנועה")
  → a status pill (§4.5) and/or `ThresholdProgress` → a **single primary
  action** on the `end` side ("שלח תזכורת", brand button).
- **Triage tone:** the card's accent is **warning** for "stuck", **neutral/info**
  for "waiting on others", **danger only** for terminal (expired). A left
  (start) accent border in the status color is acceptable as the *one* colored
  element — calm, not a fully colored card.
- **Progressive disclosure:** the card surfaces only the headline + one action;
  tapping opens the full project (E2.2). Never dump owner-by-owner detail here.
- **RTL/a11y:** action button reachable by keyboard, card itself a link if the
  whole thing navigates; the "why" sentence is real text (screen-reader reads
  the situation, not just an icon).

### 4.4 Project row (`ProjectRow`)

The dense, full-power list (one tap from the calm home; North Star principle 3).

- **Structure:** reuse the `.tbl` system (`globals.css`) or a flex row at
  `--row-h`. Columns (RTL start→end): name (`<NameDisplay>`) · status pill ·
  `ThresholdProgress` (compact) · momentum chip · owner count · updated-at
  (`tabular-nums`, Asia/Jerusalem display per CLAUDE.md). Hover
  `bg-surface-hover`; zebra via existing `[data-zebra]`.
- **RTL:** `.tbl thead th { text-align:right }` already correct. Keep numeric
  columns `tabular-nums`. Don't right/left-pin — use logical start/end.
- **a11y:** rows are `<tr>` in a real `<table>` (or list semantics); the status
  pill carries text, not just a dot; sortable headers are buttons with
  `aria-sort`.

### 4.5 Status pill (`StatusPill`) — replaces `status-badge.tsx`

This component is the **#1 re-skin fix** (§1.6). The current `status-badge.tsx`
hardcodes Tailwind defaults (`bg-amber-100`/`bg-emerald-100`/…) that don't theme.

- **Structure:** the `globals.css` `.badge` family is already token-correct
  (`.badge-success/-warning/-danger/-neutral/-info` use `var(--success-*)`
  etc.). **Re-home `StatusPill` onto these** (or onto the §3.3 Tailwind
  `bg-status-*-bg text-status-*-fg` classes). Pill = `rounded-pill`,
  `--text-label`, optional `.badge-dot` in the status color, **plus a text
  label** (always — color is never the only signal).
- **Semantic mapping (domain):** `success`=past-threshold/signed/approved ·
  `warning`=stuck/overdue/expiring · `danger`=expired/rejected (sparingly) ·
  `info`=planning/draft · `neutral`=archived/inactive. This mapping is the
  single source — defined once, consumed by every list/card.
- **Migration:** keep `StatusColor` as the *semantic* type but rename values to
  intent (`success|warning|danger|info|neutral`) instead of literal colors
  (`emerald|amber|red|gray`) — the ViewModel already supplies a semantic
  `statusColor`; this just stops leaking the literal color name into the class.
- **a11y:** the label text IS the accessible name; the dot is decorative
  (`aria-hidden`). AA contrast: `--*-700` fg on `--*-50` bg clears AA (§4.7).

### 4.6 Empty / loading / error states

Calm means the *absence* of data is handled gracefully, not a blank or a scary
red wall.

- **Loading:** reuse `ListSkeleton` (`components/ui/list-skeleton.tsx`) — already
  token-correct (`bg-muted`/`bg-card`, `animate-pulse`, `ms-auto`,
  `aria-busy/aria-live`). For cards, add a `StatCardSkeleton` in the same shape.
- **Empty:** a centered, generous, **reassuring** state — a soft outline icon
  (`--text-soft`), a one-line plain-Hebrew message ("אין פרויקטים שדורשים אותך
  עכשיו · הכול זז יפה"), and at most one CTA. Calm, never an error tone. Reuse
  the `ListPageShell` empty branch (`emptyLabel`) — but the redesign upgrades
  the bare `<p>` to this richer empty component.
- **Error:** the `ListPageShell` already distinguishes **terminal 403**
  (access-denied, no retry, `role="status"`, muted — not red) from a
  **retryable** failure (the `text-destructive` line + retry button). Keep this
  two-mode split — it's exactly the "danger sparingly" discipline. Re-token
  `text-destructive` → the danger semantic; keep the access-denied state in
  neutral/muted tone (it's not the user's fault → not red).

### 4.7 Contrast & focus (the a11y backbone)

- **Targets:** body/labels **AA (4.5:1)**, large text/UI **3:1**. Verify the
  load-bearing pairs: `--text #0f172a` on `--bg-surface #fff` (≈ very high, OK);
  `--text-muted #64748b` on `#fff` (≈ 4.6:1, **just clears AA** — do **not**
  let the designer lighten muted text further without re-checking);
  `--brand-fg #fff` on `--brand` (navy-900 #0b2545 → very high, OK; if brand
  moves to teal `172 83% 26%`, re-verify white-on-teal);
  status `*-700 on *-50` pairs clear AA. **Add a contrast check to the design
  DoD** so a re-skin can't silently drop below AA.
- **Focus:** every interactive element gets a **visible** `ring-2 ring-focus`
  (offset where it would otherwise clip). The button component already does
  `focus-visible:ring-2` — re-point `ring-primary` → `ring-focus`/brand. Never
  remove focus outlines for aesthetics.
- **Color-independence:** every status conveyed by color also carries text or an
  icon (status pills already will, per §4.5). Covers colorblindness and the
  "calm, never alarming" goal simultaneously.

---

## 5. Re-skinnability rules (keep it themeable forever)

1. **One source per concept.** Every color/space/radius/type value is defined
   **once** in Tier 1, exposed **once** as a Tier-2 semantic alias. No concept
   has two homes. (This is the existing "single source" doctrine from
   `ARCHITECTURE-fe-design-tokens.md`, extended from color to *all* token
   groups.)
2. **Components consume Tier 2 only.** Never a Tier-1 ramp step
   (`bg-navy-900`, `var(--success-600)`) and never a Tailwind **default-palette**
   class (`bg-amber-100`, `bg-red-600`, `text-gray-700`) in a component. Use
   the semantic class/var (`bg-brand`, `bg-status-warning-bg`). This is the rule
   the current `status-badge.tsx`/`button.tsx` **break** (§1.6) — the redesign
   fixes them.
3. **No new inline color — the ratchet stays green.**
   `app-no-new-inline-colors.spec.ts` must stay at/under its baseline; the
   redesign **lowers** it (every component re-homed onto tokens removes inline
   debt → lower `BASELINE_OCCURRENCES`/`BASELINE_FILES`). Treat a lowered
   baseline as a deliverable of each slice.
4. **Close the default-palette gap the ratchet can't see.** Because the ratchet
   only catches inline hex/rgb/hsl (its own "honest limits"), add a
   **review/lint rule** (or a small static spec) that flags Tailwind
   *default-palette* color classes (`(bg|text|border|ring)-(gray|slate|zinc|red|
   amber|emerald|green|blue|…)-[0-9]`) in `components/ui/*` and pages — only the
   EMAPP semantic classes are allowed. This is the one new guardrail the
   redesign needs.
5. **Semantic naming, not literal.** Tokens and props name **intent**
   (`--brand`, `status="warning"`), never appearance (`--navy-900`,
   `color="amber"`) at the component boundary. A re-skin that makes warning teal
   must not require renaming a `warning` prop to `teal`.
6. **The 4 (→5) layers collapse to {tokens + classes}.** Per the architecture
   doc's endorsed path: opportunistically convert remaining
   `style={{color:'var(--…)'}}` inline references into semantic Tailwind classes
   as each screen is touched — no big-bang. End state: Tier-1 tokens +
   Tier-2 aliases + components-via-classes. Inline reserved for genuinely
   dynamic values (e.g. a computed progress `width:%`).
7. **Dark mode + per-org branding are free outputs of the layering, not new
   work.** `.dark` (already in `globals.css`) and a per-org scope both just
   re-point Tier-2 aliases. Don't fork components for either — if you're tempted
   to, the layering is being violated.
8. **RTL is non-negotiable across any skin.** A re-skin changes values, never
   the logical-property discipline. Any new component is `ms/me`-only and
   `direction:rtl`-safe (CLAUDE.md), and directional icons mirror (§2.6).
9. **Type weights stay at Heebo 400/500/700.** A re-skin tunes sizes/spacing,
   not the loaded weight set (PR #47 LCP). Adding a weight is a perf decision,
   not a skin decision.
10. **Designer hand-off surface = `globals.css` Tier 1 (+ rarely Tier 2).**
    The designer should never need to open a `.tsx` to re-skin. If a desired
    change *requires* touching a component, that's a signal a value escaped into
    Tier 3 — pull it back into a token.

---

## 6. Recommended sequencing (non-binding, for the implementer)

1. **Add Tier-2 semantic block** to `globals.css` + semantic mappings in
   `tailwind.config.ts` (§3.2/§3.3). Additive, breaks nothing, ratchet green.
2. **Add the spacing + type scales** (the two real gaps, §1.2/§1.4).
3. **Resolve the brand fork** (navy vs teal → one `--brand`) — a one-line owner/
   designer decision, then a one-token change.
4. **Re-home `StatusPill` + `Button.destructive`** onto semantic tokens (kills
   the §1.6 leak) and add the default-palette lint rule (§5.4).
5. **Build the E2 hero components** (§4) on the semantic layer; lower the
   inline-color ratchet baseline as each lands.
6. **Validate with one screen first** (the E2.1 home), real-Chrome, against the
   North Star rubric, then expand — per the architecture doc's incremental
   rollout. Data layer is never touched → safe and reversible.

---

## 7. Cross-references

- North Star rubric: `docs/DESIGN-NORTH-STAR.md`
- Token debt + re-skin path: `docs/ARCHITECTURE-fe-design-tokens.md`
- Per-org branding spine: `docs/ARCHITECTURE-per-org-configurable-policy.md` §B
- RTL / Heebo / NameDisplay rules: `apps/web/CLAUDE.md`
- The ratchet: `apps/web/src/app-no-new-inline-colors.spec.ts`
- Tokens today: `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts`
- Components today: `apps/web/src/components/ui/{button,status-badge,list-page-shell,list-skeleton,name-display}.tsx`
