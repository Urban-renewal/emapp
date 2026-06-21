# 04 — Visual Design System & Theming Architecture (EMAPP E2 redesign · v2, second pass)

> **Role:** visual design-system expert (tokens · RTL Hebrew · re-skinnability).
> **Mandate of this pass:** depth + grounding. The first pass
> (`docs/design-research/05-visual-system.md`) was directionally right but
> theorized from the brief; it located the palette leak in *two component files*.
> This pass reads the real code and finds the leak is **deeper than a component
> file — it is born in the ViewModel + 6 adapters + their unit specs**, and it
> surfaces **two additional, unreported, currently-shipping token bugs** that a
> re-skin would inherit. Everything below cites a real file:line.
>
> **Files read for this pass (all verified, not assumed):**
> `apps/web/src/app/globals.css` · `apps/web/tailwind.config.ts` ·
> `apps/web/src/components/ui/{button,status-badge,name-display,list-page-shell,list-skeleton,confirm-dialog}.tsx` ·
> `apps/web/src/adapters/{project,apartment,signature-request,task,import,owner-project,portal}.ts` ·
> `apps/web/src/models/project.vm.ts` ·
> `apps/web/src/app-no-new-inline-colors.spec.ts` ·
> `apps/web/src/adapters/{project,apartment,portal-progress}.spec.ts` ·
> `docs/ARCHITECTURE-fe-design-tokens.md` · `docs/DESIGN-NORTH-STAR.md` ·
> `apps/web/CLAUDE.md`.
>
> Companion north-star rubric: `docs/DESIGN-NORTH-STAR.md`. Per-org branding
> spine: `docs/ARCHITECTURE-per-org-configurable-policy.md` §B.

---

## 0. Executive summary

1. **The token system is a good skeleton, not yet a theming system.** Color,
   radius, elevation, motion and Heebo are tokenized; **spacing and type are
   not** (only `--pad: 16px` and `--row-h: 44px` exist; every other gap is a
   raw Tailwind utility). This is the single biggest blocker to the North Star's
   "generous whitespace / calm" mandate, because rhythm cannot be dialed globally.

2. **The status-color leak is structural, not cosmetic — and the first pass
   under-scoped it.** It does NOT originate in `status-badge.tsx`. It originates
   in the **ViewModel type** (`project.vm.ts:28`: `statusColor: 'gray' | 'amber'
   | 'emerald' | 'red'`) and is hard-coded by **six adapters**
   (`project.ts:48`, `apartment.ts:32`, `signature-request.ts:30`, `task.ts:34`,
   `import.ts:35`, `portal.ts`) and **asserted by their unit specs**
   (`project.spec.ts:69`, `apartment.spec.ts:89`). The literal Tailwind color
   name (`amber`) is baked into the *data layer* and travels to the *class*
   (`status-badge.tsx:20` → `bg-amber-100`). A brand re-skin silently misses
   every status pill app-wide, and the fix is a **6-adapter + 3-spec + 1-VM-type
   + 1-component migration**, not a one-file edit. (§2, §4.5)

3. **Two additional shipping token bugs the first pass did not catch:**
   - **`bg-card` is a dead class.** It is used in **41 files** (incl.
     `list-skeleton.tsx:29`, `confirm-dialog.tsx:208`) but `card` is **not
     defined** in `tailwind.config.ts theme.extend.colors` (only `background`,
     `foreground`, `muted`, `primary`, `border` are). So `bg-card` /
     `text-card-foreground` resolve to nothing — the loading skeleton and the
     confirm modal render with **no surface background**. (§1.8)
   - **The `--r-lg` radius is double-defined and disagrees with itself** —
     `globals.css:102` says `--r-lg: 12px`, but `tailwind.config.ts:139` maps
     `borderRadius.lg → var(--radius)` = `0.5rem` = **8px**. `.card` (12px) and a
     `rounded-lg` Tailwind utility (8px) produce visibly different corners. (§1.4)

4. **The fix is the 3-tier layering** (primitive → semantic alias → components
   consume aliases ONLY), plus the two missing scales (`--space-*`, `--text-*`),
   plus a **default-palette lint guard** the existing ratchet structurally cannot
   see. Then dark-mode and per-org branding fall out for free. (§3, §5)

5. **Owner decisions surfaced (§7):** (a) brand-color fork — shadcn `--primary`
   is **teal** (`172 83% 26%`), partner `--primary-partner` is **navy**
   (`#0b2545`); they coexist and *both currently render* on different surfaces.
   One must win. (b) Whether the adapter `statusColor` value migrates from literal
   color to semantic intent now (clean) or stays literal behind a mapping layer
   (cheaper, leak persists in the VM type).

---

## 1. Grounded audit of the current token system

### 1.1 Color — three palettes + a fourth default-palette leak (confirmed)

`globals.css :root` (lines 50–112) declares **two** of the palettes:

- **shadcn HSL vars** (`globals.css:52–59`): `--background 0 0% 100%`,
  `--foreground 20 14.3% 4.1%`, `--muted`, `--muted-foreground`, `--border`,
  `--primary 172 83% 26%` (**teal**), `--primary-foreground`, `--radius 0.5rem`.
  These back the shadcn `components/ui/*`.
- **Partner semantic aliases (hex)** (`globals.css:61–111`):
  `--bg-app #f5f7fa`, `--bg-surface`, `--bg-subtle`, `--bg-hover`,
  `--border-strong`, `--text #0f172a`, `--text-muted #64748b`, `--text-soft`,
  ramps `--navy-*`, `--ink-*`, `--success-*`, `--warning-*`, `--danger-*`, and
  `--primary-partner: var(--navy-900)` (**navy**).

`tailwind.config.ts:96–135` declares a **third** copy: the partner ramps
re-typed as **raw hex** under `theme.extend.colors` (`navy`, `ink`, `success`,
`warning`, `danger`). The file's own header (`tailwind.config.ts:23–30` and
`globals.css:19–28`) flags this as "KNOWN DUPLICATION … MUST be kept in
lock-step." This is real, documented, accepted debt.

**The fourth palette — the leak** — is the Tailwind *default* palette reached
directly by components and the data layer (§1.6). It is invisible to the token
system entirely.

**Verdict (refined from v1):** coverage is sufficient to theme from; the problem
is **multiplicity + a forked primary + a default-palette escape hatch**. v1 said
this. What v1 missed is *where the escape hatch is anchored* — see §1.6.

### 1.2 Spacing — effectively no scale (confirmed, this is the #1 gap)

`globals.css` defines exactly two spacing-ish tokens: `--pad: 16px`
(`globals.css:106`) and `--row-h: 44px` (`globals.css:105`), plus density
overrides that retune them (`[data-density='compact']` → `--pad:12px`,
`globals.css:413–427`). **There is no `--space-*` ramp.** Every other gap in the
app is a raw Tailwind utility (`p-4`, `gap-3`, `space-y-3`) — confirmed in every
component read (e.g. `list-skeleton.tsx:24,27,29` `space-y-3 / space-y-2 / gap-3
p-4`; `confirm-dialog.tsx:202,208,216` `p-4 / space-y-4 p-6 / gap-2`).

**Consequence:** the North Star's "generous whitespace, calm, breathe" cannot be
expressed as a token change. A designer who wants 25% more air must edit hundreds
of utility classes across screens. **Rhythm is not themeable.** This is the
biggest structural gap. Fix in §2.4 / §3.2.

### 1.3 Elevation — present, soft, flat (confirmed, keep)

`tailwind.config.ts:143–149` defines `boxShadow.xs..xl` all on ink rgba
(`rgba(15,23,42,*)`), not black — soft and low-contrast, already aligned with
"calm." `.card` (`globals.css:227–232`) uses only `0 1px 2px rgba(15,23,42,.04)`.
Keep; use sparingly (hairline border + at most `shadow-xs` for default cards).

### 1.4 Radius — present but **self-contradictory** (NEW finding)

`globals.css:100–104` defines `--r-sm 6 / --r-md 8 / --r-lg 12 / --r-xl 16 /
--r-2xl 20`. But `tailwind.config.ts:136–142` maps:
```
borderRadius: { sm:'6px', md:'8px', lg:'var(--radius)', xl:'16px', '2xl':'20px' }
```
and `--radius` is `0.5rem = 8px` (`globals.css:59`). So:

- `.card` (`globals.css:230`) uses `var(--r-lg)` = **12px**.
- A Tailwind `rounded-lg` utility = `var(--radius)` = **8px**.

Two components both nominally "lg-rounded" render **different corners**. v1
flagged this as "minor"; it is small but real and a re-skin makes it worse (a
designer changing `--radius` moves `rounded-lg` but not `.card`). Resolve by
pointing `borderRadius.lg → var(--r-lg)` (or aliasing `--radius: var(--r-md)` and
introducing a distinct `--radius-card`). See §3.2.

### 1.5 Type — Heebo loaded at 3 weights; sizes NOT tokenized (confirmed)

`tailwind.config.ts:79–81` sets `fontFamily.sans → var(--font-heebo)` (loaded via
`next/font` in `[locale]/layout.tsx`, 400/500/700 per the header note, PR #47 LCP
gain). But **no size/line/weight token set exists** — sizes are hard-coded per
class: `.btn` 14px (`globals.css:179`), `.card-hd h3` 15px/700
(`globals.css:246–247`), `.badge` 12px (`globals.css:257`), `.tbl` 13.5px
(`globals.css:380`), `.label` 12px (`globals.css:329`), and elsewhere via
`text-sm`/`text-xs`. The `globals.css:40–42` header itself admits the
"700-vs-600 hierarchy" is unresolved and defers it to "a dedicated typography
slice." **This redesign is that slice.** Hebrew has no case and no italics, so
hierarchy must come from **size + weight + color** only. Fix in §2.2 / §3.2.

### 1.6 The leak's true home — the DATA layer (NEW depth; v1's biggest miss)

v1 located the leak in `status-badge.tsx` and `button.tsx`. The real anchor is
upstream. The **ViewModel type itself** encodes literal Tailwind colors:

- `models/project.vm.ts:28` — `statusColor: 'gray' | 'amber' | 'emerald' | 'red'`
  (comment line 27 even calls it "Locked color palette").

Six adapters **map domain status → that literal color**:

- `adapters/project.ts:48–55` — `gathering_signatures:'amber'`,
  `approved/in_construction:'emerald'`, `cancelled:'red'`, `planning/completed:'gray'`.
- `adapters/apartment.ts:32`, `adapters/signature-request.ts:30`,
  `adapters/task.ts:34`, `adapters/import.ts:35`, `adapters/portal.ts`
  (`APARTMENT_STATUS_COLORS:55`, `PROJECT_STATUS_COLORS`, `SIG_STATUS_COLORS`,
  used at lines 239/254/292/333) — all the same `Record<Status, 'gray'|'amber'|
  'emerald'|'red'>` shape.

And **unit specs assert the literal value**, so they pin the leak in place:

- `adapters/project.spec.ts:69` — `expect(['gray','amber','emerald','red']).toContain(vm.statusColor)`.
- `adapters/apartment.spec.ts:89,93` — `expect(signedHe.statusColor).toBe('emerald')`,
  `expect(refusedEn.statusColor).toBe('red')`.
- `adapters/portal-progress.spec.ts:74` — `expect(vm.statusColor).toBe('amber')`.

Then the **component** maps that literal to the Tailwind default palette:

- `status-badge.tsx:20–25` — `STATUS_BADGE_CLASS: { gray:'bg-gray-100
  text-gray-700', amber:'bg-amber-100 text-amber-800', emerald:'bg-emerald-100
  text-emerald-800', red:'bg-red-100 text-red-800' }`.

`gray / amber / emerald / red` are **Tailwind built-ins**, NOT the EMAPP
`ink / warning / success / danger` ramps in `tailwind.config.ts:105–134`. A
re-skin that warms `--warning-*` leaves every status pill on stock amber. **The
blast radius of fixing this is: 1 VM type + 6 adapters + 3 specs + 1 component**
— a slice, not a one-liner. This reframing is the most important correction this
pass makes to v1.

`button.tsx:17` carries the parallel leak: `destructive: 'bg-red-600 text-white'`
(stock `red-600`), while the equivalent global class `.btn-danger`
(`globals.css:208–211`) correctly uses `var(--danger-600)`. So the *same intent*
("destructive") is themed in one place and stock in the other —
`confirm-dialog.tsx:235` reaches for the correct `.btn-danger`, while a raw
`<Button variant="destructive">` renders stock red. Inconsistent by source.

### 1.7 Why the ratchet cannot catch this (confirmed by reading the spec)

`app-no-new-inline-colors.spec.ts` matches only three regexes: `HEX_COLOR`
(`:80`), `HSL_COLOR` (`:82`), `RGB_COLOR` (`:93`). Its own "honest limits" block
(`:14–31`) states it deliberately does NOT catch **bare named CSS colors** or
**default-palette Tailwind class names** — only inline functional/hex literals.
`bg-amber-100` is a class name with zero hex/rgb/hsl, so it sails through. The
baseline is frozen at `BASELINE_OCCURRENCES=58 / BASELINE_FILES=9`
(`:76–77`) — and notably **none of those 9 files is `status-badge.tsx` or
`button.tsx`**, proving the leak is structurally outside the guard's vision.
The redesign needs a **second, class-name guard** (§5.4).

### 1.8 `bg-card` is a dead utility (NEW finding — shipping bug)

shadcn convention uses `bg-card` / `text-card-foreground` for surfaces. The repo
uses `bg-card` in **41 files** (grep-confirmed), including hero chrome:
`list-skeleton.tsx:29` (`border bg-card p-4`) and `confirm-dialog.tsx:208`
(`rounded-lg border bg-card`). But `tailwind.config.ts theme.extend.colors`
(`:82–135`) defines **only** `border`, `background`, `foreground`, `primary`,
`muted`, plus the partner ramps — **there is no `card` color**, and `globals.css`
defines no `--card` var. `card` appears in the config **only** as a safelisted
*global-class* name (`tailwind.config.ts:52`, the `.card` component class), which
is unrelated to the `bg-card` color utility.

**Consequence:** `bg-card` resolves to no background. The loading skeleton rows
and the confirm modal panel render transparent (they survive visually only
because of the surrounding `border` + the page background showing through).
Any redesign that relies on `bg-card` for a real surface will silently fail.
**Fix:** define `card` / `card-foreground` as semantic Tier-2 tokens (§3.2/§3.3)
— they should map to `--surface` — OR migrate those 41 usages to `bg-surface`.
This is also a re-skin hole: an org override of "card surface" has nowhere to land.

### 1.9 RTL + bidi primitives — solid, inherit unchanged (confirmed)

`body { direction: rtl }` (`globals.css:135`), `tailwindcss-rtl` plugin
(`tailwind.config.ts:33,178`), the `ms-*`/`me-*` discipline (`apps/web/CLAUDE.md`
"RTL-first" rule), and `<NameDisplay>` (`name-display.tsx`) bidi isolation
(`<bdi>` + `stripBidiOverrides`, closing §v9-H-3) are all in place and correct.
The component specs below **inherit** these obligations; they are not re-derived.
Note `confirm-dialog.tsx` and `list-skeleton.tsx` already use logical props
correctly (`text-start` `:208`, `ms-auto` `:32`).

### 1.10 Audit scorecard (grounded)

| Token group | State (file:line) | Themeable today? | Action |
|---|---|---|---|
| Color | 3 palettes (`globals.css:52–111`, `tailwind:96–135`) + default-palette leak (`status-badge.tsx:20`) | Partial | Collapse to one source; kill the leak at the **adapter** layer |
| Spacing | Only `--pad`/`--row-h` (`globals.css:105–106`) | **No** | **Add `--space-*` ramp** (#1 gap) |
| Radius | `--r-*` (`globals.css:100`) **vs** `borderRadius.lg→--radius=8px` (`tailwind:139`) | Inconsistent | Align `lg`; one source |
| Type | Heebo 3wt; sizes hard-coded per class | **No** | **Add `--text-*` size/lh/weight tokens** |
| Elevation | `xs..xl` ink rgba (`tailwind:143`) | Yes | Keep; use flat |
| `card` surface | `bg-card` used ×41 but **undefined** | **Broken** | **Define `card` token** (§1.8) |
| RTL / bidi | `dir:rtl`, `ms/me`, NameDisplay | Yes | Inherit unchanged |

---

## 2. Proposed visual language (grounded in the existing ramps)

The emotional brief (North Star §"Emotional target", `DESIGN-NORTH-STAR.md:55`):
the יזם opens a screen and **relaxes**. Every choice below serves *relief, not
density*, and reuses an existing ramp wherever one exists — minimizing the
re-skin surface.

### 2.1 Color roles — semantic, never decorative

| Role | Meaning in EMAPP (signature collection) | Existing source ramp | Note |
|---|---|---|---|
| **Brand** | identity, primary actions, active nav, focus ring | **the fork** — `--primary` teal (`globals.css:57`) vs `--primary-partner` navy (`globals.css:111`) | Must become ONE `--brand`. Navy (`--navy-900 #0b2545`) reads "real-estate institutional / trustworthy"; teal is the shadcn default. **Owner/designer decision (§7).** |
| **Success / past-threshold** | crossed the legal majority ("עברנו את הרוב הדרוש"); an owner signed | `--success-*` (`globals.css:87–90`) | Calm green at the *moment of relief* — not a generic "on" color. |
| **Warning / stuck** | no movement N days ("תקוע"), reminder overdue, nearing expiry | `--warning-*` (`globals.css:91–94`) | The **dominant** triage attention color. Amber = "nudge", not failure. |
| **Danger** (sparingly) | destructive/irreversible (archive-with-loss), terminal (expired/rejected) | `--danger-*` (`globals.css:95–98`) | A *stuck* signature is **warning**, never danger — over-red breaks "calm." |
| **Info / neutral** | planning, draft, archived | `--navy-50/100` / `--ink-*` | Quiet. |
| **Text (3 steps)** | foreground / secondary / tertiary | `--text` / `--text-muted` / `--text-soft` (`globals.css:69–71`) | Keep exactly 3 — no fourth grey. |
| **Surfaces** | app / card / subtle / hover | `--bg-app/-surface/-subtle/-hover` (`globals.css:64–67`) | Warm-neutral, not pure cold white. |

> **Warmth knob.** Today `--bg-app #f5f7fa` and `--text #0f172a` are cool slate.
> "Warm + reassuring" is achievable by nudging `--bg-surface`/`--bg-app` a few
> degrees toward paper-off-white — a pure **token-value** change, exactly the
> re-skin surface we are building. Text is already `#0f172a` (not pure black) —
> good, keep.

### 2.2 Type scale — Hebrew-first, on Heebo (tokenize the hard-coded sizes)

Heebo @ 400/500/700 (already loaded; do NOT add weights — PR #47 LCP). Hierarchy
= size + weight + color (no caps, no italics — Hebrew has neither).

| Token | px / line-height | Weight | Use (replaces) |
|---|---|---|---|
| `--text-display` | 28 / 36 | 700 | the one big "where you stand" number |
| `--text-title` | 20 / 28 | 700 | section + card titles (replaces ad-hoc `.card-hd h3` 15/700, `globals.css:246`) |
| `--text-subtitle` | 16 / 24 | 500 | the plain-Hebrew "why" sentence |
| `--text-body` | 14 / 22 | 400 | body, table cells (replaces `.btn` 14, `.tbl` 13.5) |
| `--text-label` | 13 / 18 | 500 | field labels, badge text (replaces `.label`/`.badge` 12) |
| `--text-caption` | 12 / 16 | 400 | timestamps, fine print (`--text-soft`) |

Rules: numbers carry `font-variant-numeric: tabular-nums` (the `.tabular`
utility already exists, `globals.css:470–472`) so counts/percentages don't
jitter. Never below 12px for Hebrew legibility. **Weight 500 is "calm
emphasis"** — prefer it; reserve 700 for the single hero number + titles. This
directly resolves the `globals.css:40–42` open hierarchy question.

### 2.3 Words lead, numbers serve (visual side of "plain Hebrew")

North Star principle 2 + the central doctrine: a stat/triage card renders the
**sentence** ("כמעט שם · חסרה חתימה אחת") as primary (`--text-subtitle`) and the
metric (`64%`) as secondary (`--text-muted`). The type scale deliberately gives
the sentence more weight than the number. **Never a bare metric as a hero.**

### 2.4 Spacing rhythm — the missing scale (4px base, generous)

Introduce the ramp the app lacks (§1.2):
`--space-1 4 · -2 8 · -3 12 · -4 16 · -5 20 · -6 24 · -8 32 · -10 40 · -12 48`.
Defaults for the calm redesign: card padding `--space-5`, inter-card gap
`--space-4/-6`, page gutter `--space-6`+, section rhythm `--space-8`. The
existing `--pad 16` becomes an **alias** `--pad: var(--space-4)` so the density
modes (`globals.css:413–427`) keep working unchanged. The designer dials all
whitespace by editing this one ramp.

### 2.5 Radius & elevation — soft, flat, ONE source

Keep the `--r-*` ramp; **fix the `--r-lg` fork** (§1.4) so `rounded-lg` and
`.card` agree. Cards `--r-lg`, controls `--r-md`, pills 999px, modals `--r-xl`.
Default card = hairline `1px var(--border)` + at most `shadow-xs` (matches
`.card`, `globals.css:231`). Reserve `shadow-md/lg` for genuinely floating layers
(dropdown/popover/modal). No shadow stacks, no glows.

### 2.6 Iconography & motion (keep what exists)

- One **outline/stroked** library (lucide-react, the shadcn default). Default
  20px (inline 16px), stroke ~1.75. Icon color **inherits `currentColor`** so it
  themes for free — never hardcode an icon color (would trip the ratchet anyway).
- Directional icons (chevron "next/back") must mirror under RTL — rely on
  `tailwindcss-rtl` or swap by `dir`, never hardcode a left-chevron for "forward."
- Motion: keep `tailwind.config.ts:150–175` keyframes (`fade-in .18s`,
  `slide-up .22s`, `scale-in .18s`) — short, ease-out, calm. **Honor
  `prefers-reduced-motion`** (currently not gated — add the media-query guard).

---

## 3. Theming architecture — the 3-tier layering

Goal: **the designer re-skins by editing Tier-1 token values; no `.tsx` changes.**

```
TIER 1 — PRIMITIVE TOKENS  (raw scales; the designer's editing surface)
   --navy-900, --ink-500, --success-600, --space-4, --r-lg,
   --text-title-size, Heebo …  pure values, no meaning.
         ▼ referenced by
TIER 2 — SEMANTIC ALIASES  (roles; the stable contract)
   --brand, --brand-fg, --surface, --surface-subtle, --text, --text-muted,
   --status-success-bg/-fg, --space-card, --radius-card, --focus-ring …
   each = var(<Tier-1 token>).  Meaning here, values not.
         ▼ consumed by (ONLY this layer)
TIER 3 — COMPONENTS  (button, card, StatCard, ThresholdProgress, StatusPill…)
   Consume ONLY Tier-2 aliases (via Tailwind classes mapping to them, or
   var(--semantic) in a class). NEVER a Tier-1 ramp step, NEVER raw hex,
   NEVER a Tailwind default-palette class.
```

### 3.1 Why three tiers, given today's two

Today `globals.css` has primitives (`--navy-*`) **and** some semantic aliases
(`--text`, `--bg-surface`) — but components reach into **both** inconsistently
(`var(--text)` in `.input`, `var(--navy-900)` via `--primary-partner`,
`bg-amber-100` in `status-badge.tsx`). The fix is the **discipline that Tier 3
touches ONLY Tier 2**. Then re-skin = edit Tier 1; per-org branding = override a
handful of Tier-1/Tier-2 vars on a scoped root; dark mode = the existing `.dark`
block (`globals.css:114–122`) re-points Tier-2 aliases. All three fall out of the
same layering.

### 3.2 Concrete additions to `globals.css` (additive — breaks nothing)

```css
:root {
  /* ── TIER 2: SEMANTIC ALIASES (the contract Tier-3 consumes) ── */

  /* brand — resolve the navy/teal fork to ONE source (§7 owner call) */
  --brand:        var(--navy-900);    /* recommend navy; designer decides */
  --brand-hover:  var(--navy-800);
  --brand-fg:     #ffffff;            /* AA on navy-900 — verify §4.7 */
  --focus-ring:   var(--navy-500);

  /* surfaces & text — formalize the existing partner aliases as Tier 2 */
  --surface:        var(--bg-surface);
  --surface-subtle: var(--bg-subtle);
  --surface-app:    var(--bg-app);
  --surface-hover:  var(--bg-hover);
  /* --text / --text-muted / --text-soft already exist — keep as Tier 2 */

  /* card surface — FIXES the dead `bg-card` utility (§1.8) */
  --card:    var(--surface);
  --card-fg: var(--text);

  /* status — the ONE place status color lives; kills the leak (§1.6/§4.5) */
  --status-success-bg: var(--success-50);  --status-success-fg: var(--success-700);
  --status-warning-bg: var(--warning-50);  --status-warning-fg: var(--warning-700);
  --status-danger-bg:  var(--danger-50);   --status-danger-fg:  var(--danger-700);
  --status-info-bg:    var(--navy-50);     --status-info-fg:    var(--navy-800);
  --status-neutral-bg: var(--ink-100);     --status-neutral-fg: var(--ink-700);

  /* spacing — NEW (fills §1.2) */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px; --space-12:48px;
  --space-card: var(--space-5);
  --pad: var(--space-4);              /* back-compat alias; density modes keep working */

  /* type — NEW size/line/weight (fills §1.5) */
  --text-display-size:28px; --text-display-lh:36px;
  --text-title-size:20px;   --text-title-lh:28px;
  --text-subtitle-size:16px;--text-subtitle-lh:24px;
  --text-body-size:14px;    --text-body-lh:22px;
  --text-label-size:13px;   --text-label-lh:18px;
  --text-caption-size:12px; --text-caption-lh:16px;
  --weight-regular:400; --weight-medium:500; --weight-bold:700;

  /* radius — alias the existing --r-* ramp; FIX the lg fork (§1.4) */
  --radius-card: var(--r-lg); --radius-control: var(--r-md); --radius-pill:999px;
}
```

### 3.3 Concrete additions to `tailwind.config.ts`

So components author in Tailwind (the team idiom) but every utility resolves to a
**semantic** token:

- **`colors`** — add `brand`/`brand-fg`/`focus` → Tier-2 vars; add the missing
  **`card`/`card-foreground`** (fixes §1.8) → `var(--card)`/`var(--card-fg)`;
  add `surface:{DEFAULT,subtle,app,hover}`; add `status:{'success-bg':…, …}`.
  Keep the existing `navy`/`ink`/`success`/… ramps but **treat them as Tier 1 —
  Tier-3 stops using them directly** (the §5.4 lint rule enforces this).
- **`spacing`** — extend `1..12` → `var(--space-*)`, `card → var(--space-card)`,
  so `p-card` / `gap-6` / `space-y-8` are tokenized.
- **`fontSize`** — add `display/title/subtitle/body/label/caption` →
  `['var(--text-*-size)', { lineHeight:'var(--text-*-lh)' }]`.
- **`borderRadius`** — point `lg → var(--r-lg)` (the §1.4 fix); add
  `card/control/pill` → the radius aliases.
- **`ringColor`** — `button.tsx:10` uses `ring-primary`; re-point a named
  `ring-focus` → `var(--focus-ring)` so focus themes with brand.

### 3.4 The end state

A card authors as `bg-card p-card rounded-card text-body shadow-xs border
border-border`; a status pill as `bg-status-warning-bg text-status-warning-fg`.
**Zero** Tier-1 ramp refs, zero default-palette classes, zero inline hex.
Re-skin = edit `globals.css` Tier 1. Done.

---

## 4. Hero component-library spec (E2)

**Global obligations for EVERY component** (stated once):

- **RTL:** logical props only — `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`,
  `text-start`/`text-end`. Never `ml/mr/left/right`. (CLAUDE.md rule.)
- **Bidi (§v9-H-3):** every name/string from a user or the wire renders inside
  `<NameDisplay>` (`name-display.tsx`). Hard-coded i18n labels do not.
- **Color:** only Tier-2 semantic tokens / the §3.3 semantic classes. No hex/
  rgb/hsl (ratchet), no default-palette class (§5.4 guard).
- **a11y:** WCAG **AA** contrast (§4.7), visible `ring-2 ring-focus`, `aria-*`
  where state is color-only, and **a text/icon label beside every color** — color
  is NEVER the only signal (colorblind + "calm, never alarming").

### 4.1 `StatCard` — the home pulse tile

`bg-card rounded-card border border-border shadow-xs p-card`. A `--text-label`
eyebrow (metric name) → the **hero number** `--text-display tabular-nums` → a
**plain-Hebrew sentence** `--text-subtitle text-muted` (the "why") → optional
trend chip ("+2 השבוע" success / "אין תנועה 18 יום" warning) on the **end** side
(`ms-auto`). If the card is a *triage* signal, the sentence leads and the number
is secondary (§2.3). If a link, the whole card is one focusable target with a
visible ring. Provide a `StatCardSkeleton` in the same shape (reuse the
`animate-pulse` idiom from `list-skeleton.tsx`).

### 4.2 `ThresholdProgress` — % signed vs the required legal majority

The domain's defining mechanic ("past the threshold" = relief). Extend `.progress`
(`globals.css:356–374`).

- **Structure:** a track (re-token `bg-ink-100`, `globals.css:359`, → a neutral
  `--surface-subtle`/track token), a fill `var(--brand)`, and a **threshold
  marker** — a 2px vertical rule at the required-% position
  (`inset-inline-start`, NOT `left`) with an accessible label ("רוב דרוש: 66%").
  The required % is real data: `ProjectViewModel.targetConsentPct`
  (`project.vm.ts:35`, sourced from `p.targetSignaturePct`). **Do not hardcode
  66%** — read it from the VM; it is per-project and per-track.
- **Color logic:** fill is brand/neutral **below** threshold, flips to
  `--status-success` the instant it **crosses** (relief). "Stuck near but below"
  is signaled by the surrounding card's warning cue, **not** the bar — the bar
  shows progress, the card shows mood.
- **RTL:** with `direction:rtl` a `width:%` fill from inline-start fills from the
  right automatically; the marker must use `inset-inline-start`.
- **a11y:** `role="progressbar"` + `aria-valuenow/min/max` +
  `aria-valuetext="32 מתוך 50 חתמו · עברו את הרוב הדרוש"`. Never communicate
  "past threshold" by color alone.
- **Data caveat (cite the master plan):** the headline % itself may be **legally
  wrong today** — consent is counted apartments-consented/total and ignores the
  registered `ownerships.share_numerator/denominator` (see
  `00-MASTER-PLAN.md §2.2`). That is a **domain/data correctness** issue (a
  separate slice + owner decision), not a visual one — but the component must be
  built to render whatever weighted % the backend eventually supplies, not assume
  a head-count. Flagged so the visual layer is not blamed for a counting bug.

### 4.3 `ActionCard` — the triage card ("needs you now")

`bg-card rounded-card border border-border p-card`, generous `--space-4` gaps.
RTL start→end: project name (`<NameDisplay>`, `--text-title`) → the plain-Hebrew
situation sentence (`--text-subtitle text-muted`, e.g. "אורי דירה 7 לא חתם · 18
יום ללא תנועה") → a `StatusPill` and/or compact `ThresholdProgress` → a **single
primary action** on the end side ("שלח תזכורת", brand button). Accent =
**warning** for stuck, **info/neutral** for waiting-on-others, **danger only**
for terminal. A start-edge accent border in the status color is the ONE colored
element — calm, not a fully colored card. Surfaces only headline + one action;
tapping opens the full project (E2.2). The "why" is real text (screen-reader
reads the situation, not an icon).

> **"Why"-layer honesty:** the human bottleneck phrase ("3 בעלים מתנגדים") needs
> a backend objection/decline-reason field that does **not exist yet**
> (`00-MASTER-PLAN.md §6 B2` — one `ALTER TABLE … ADD COLUMN decline_reason`).
> Until it ships, **omit the phrase, never fabricate it** (North Star
> "What this is NOT"). The component must degrade gracefully when the field is null.

### 4.4 `ProjectRow` — the dense full-power list

Reuse the `.tbl` system (`globals.css:376–411`) or a flex row at `--row-h`.
Columns (RTL start→end): name (`<NameDisplay>`) · `StatusPill` ·
`ThresholdProgress` (compact) · momentum chip · owner count · updated-at
(`tabular-nums`, **Asia/Jerusalem** display per CLAUDE.md). Hover
`bg-surface-hover`; zebra via the existing `[data-zebra]` (`globals.css:406`).
`.tbl thead th { text-align:right }` is already correct (`globals.css:383`).
Sortable headers are buttons with `aria-sort`; the pill carries text, not just a
dot.

### 4.5 `StatusPill` — replaces `status-badge.tsx` (the #1 re-skin fix)

The `globals.css .badge` family (`:250–307`) is **already token-correct**
(`.badge-success/-warning/-danger/-neutral/-info` use `var(--success-*)` etc.).
**Re-home the pill onto these** (or the §3.3 `bg-status-*-bg text-status-*-fg`
classes). Pill = `rounded-pill`, `--text-label`, optional `.badge-dot`
(`aria-hidden`, decorative) **plus a text label always** (color never the only
signal).

**Domain mapping (the single source):** `success`=past-threshold/signed/approved ·
`warning`=stuck/overdue/expiring · `danger`=expired/rejected (sparingly) ·
`info`=planning/draft · `neutral`=archived/inactive.

**Migration (the grounded blast radius — v1 understated this):**
1. `models/project.vm.ts:28` (and the analogous `statusColor` fields in the
   apartment / task / import / signature-request / portal VMs): change the type
   from `'gray'|'amber'|'emerald'|'red'` → `'success'|'warning'|'danger'|'info'|'neutral'`.
2. The **6 adapters** (`project.ts:48`, `apartment.ts:32`,
   `signature-request.ts:30`, `task.ts:34`, `import.ts:35`, `portal.ts` ×3 maps):
   re-key the `Record<Status, …>` values to intent.
3. The **3 specs** (`project.spec.ts:69`, `apartment.spec.ts:89,93`,
   `portal-progress.spec.ts:74`): update the asserted literals to the intent
   values.
4. The component: `StatusPill` consumes the intent value and applies the
   `.badge-*` / `bg-status-*` class — no literal-color `Record` at all.

This is a single coherent slice. Doing it now (vs. a mapping shim) is the clean
choice; the shim option keeps the leak in the VM type (§7 decision).

### 4.6 Empty / loading / error (calm absence of data)

- **Loading:** reuse `ListSkeleton` (`list-skeleton.tsx`) — already token-ish
  (`animate-pulse`, `ms-auto`, `aria-busy/aria-live`) **but fix its `bg-card`**
  (§1.8) so rows actually have a surface. Add a `StatCardSkeleton`.
- **Empty:** upgrade the bare `<p>{emptyLabel}</p>` in `ListPageShell`
  (`list-page-shell.tsx:144`) to a centered, generous, **reassuring** state — a
  soft outline icon (`--text-soft`), one plain-Hebrew line ("אין פרויקטים
  שדורשים אותך עכשיו · הכול זז יפה"), at most one CTA. Calm tone, never error.
- **Error:** `ListPageShell` already splits **terminal 403**
  (`isPermissionDenied`, `list-page-shell.tsx:28,123–132`, `role="status"`,
  muted — correctly **not** red) from a **retryable** failure (`text-destructive`
  + retry, `:133–140`). Keep this two-mode split — it *is* the "danger sparingly"
  discipline. Re-token `text-destructive` → the danger semantic; keep
  access-denied neutral (not the user's fault → not red).

### 4.7 Contrast & focus (the a11y backbone — verify the load-bearing pairs)

- **Targets:** body/labels AA (4.5:1), large/UI 3:1. Verify the real pairs:
  - `--text #0f172a` on `--bg-surface #fff` → very high, OK.
  - `--text-muted #64748b` on `#fff` → **≈4.6:1, *just* clears AA** — the
    designer must NOT lighten muted text further without re-checking. Pin this in
    the design DoD.
  - `--brand-fg #fff` on navy-900 `#0b2545` → very high, OK. **If brand becomes
    teal** (`172 83% 26%`), re-verify white-on-teal.
  - status `*-700` fg on `*-50` bg → clears AA.
- **Focus:** every interactive element gets a visible `ring-2 ring-focus`.
  `button.tsx:10` already does `focus-visible:ring-2 focus-visible:ring-primary`
  — re-point `ring-primary → ring-focus`/brand. Never remove focus outlines.
- **Color-independence:** every color-coded status also carries text/icon (the
  pills already will). One rule covers colorblindness + "calm, never alarming."

---

## 5. The exact Tier-1-only re-skin workflow (the deliverable the owner asked for)

**What the owner's external designer does to re-skin — and ONLY this:**

1. Open **one file**: `apps/web/src/app/globals.css`, the `:root` block.
2. Edit **Tier-1 primitive values** only — the raw ramps and scales:
   `--navy-*`, `--ink-*`, `--success-*`/`--warning-*`/`--danger-*`, `--space-*`,
   `--r-*`, `--text-*-size`/`-lh`, `--bg-*`/`--text*`. (Pure values, no meaning.)
3. **Rarely**, re-point a **Tier-2 alias** to a different ramp (e.g. make the
   brand a different ramp: `--brand: var(--navy-700)` instead of `--navy-900`).
4. Run `pnpm --filter @emapp/web test app-no-new-inline-colors` — it stays green
   (the designer touched only the `.css` definition file, which is out of the
   ratchet's scope by design, `spec :29–30`). Visual-regression / Chrome smoke
   per the slice DoD.
5. **Never open a `.tsx`.** If a desired change *requires* touching a component,
   that is the signal a value escaped into Tier 3 — file it as "pull this back
   into a token," do not let the designer hand-edit the component.

**Why dark mode is free:** the `.dark` block already exists
(`globals.css:114–122`) and today only re-points the shadcn HSL vars. Under the
3-tier model it re-points the **Tier-2 aliases** (`--brand`, `--surface`,
`--status-*-bg/fg`, `--card`) — no component forks, no new work. The designer
adds dark values in the same one file.

**Why per-org branding is free:** per the per-org spine
(`ARCHITECTURE-per-org-configurable-policy.md §B`: default + override), an org's
brand is a **scoped root** (`[data-org="…"]` or a `<style>` injected at the org
shell) that overrides a handful of Tier-1/Tier-2 vars (`--brand`, `--brand-fg`,
maybe `--surface`). It works **only because there is one token source to
override** — which is exactly why `ARCHITECTURE-fe-design-tokens.md:31–37` calls
the token consolidation the *prerequisite* for per-org branding, not a detour.

---

## 6. Re-skinnability rules (keep it themeable forever)

1. **One source per concept.** Every color/space/radius/type value defined once
   in Tier 1, exposed once as a Tier-2 alias. (Extends the existing color
   "single source" doctrine to *all* token groups.)
2. **Tier 3 consumes Tier 2 only.** Never a Tier-1 ramp step (`bg-navy-900`,
   `var(--success-600)`), never a Tailwind default-palette class (`bg-amber-100`,
   `bg-red-600`, `text-gray-700`). The rule `status-badge.tsx:20` and
   `button.tsx:17` break — the redesign fixes them at the adapter source (§4.5).
3. **The inline-color ratchet stays green and ratchets DOWN.** Every component
   re-homed onto tokens *lowers* `BASELINE_OCCURRENCES`/`BASELINE_FILES`
   (`app-no-new-inline-colors.spec.ts:76–77`). Treat a lowered baseline as a
   per-slice deliverable.
4. **Add the default-palette guard the ratchet structurally can't see.** Because
   the ratchet only matches hex/rgb/hsl (`spec :80,82,93` + the "honest limits"
   block), add a second static spec that flags
   `(bg|text|border|ring)-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|
   lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]`
   in `components/**` and `app/**`. Only EMAPP semantic classes pass. **This is
   the one new guardrail the redesign requires** — without it the leak silently
   returns.
5. **Semantic naming, not literal.** Tokens/props name **intent** (`--brand`,
   `status="warning"`), never appearance (`--navy-900`, `color="amber"`) at the
   component boundary. The §4.5 VM-type migration is exactly this rule applied to
   the data layer.
6. **Fix the dead `card` token (§1.8)** as part of step 4 — either define
   `--card`/`card` (recommended) or migrate the 41 `bg-card` usages to
   `bg-surface`. A re-skin can't theme a surface that doesn't resolve.
7. **Dark mode + per-org branding are outputs of the layering, not new work**
   (§5). If you're tempted to fork a component for either, the layering is being
   violated.
8. **RTL is non-negotiable across any skin.** A re-skin changes values, never the
   `ms/me` + `direction:rtl` discipline; directional icons mirror (§2.6).
9. **Heebo stays 400/500/700.** A re-skin tunes sizes/spacing, not the weight set
   (PR #47 LCP). Adding a weight is a perf decision, not a skin decision.
10. **Designer hand-off surface = `globals.css` Tier 1 (+ rarely Tier 2).** The
    designer never opens a `.tsx`. (§5.)

---

## 7. Decisions that belong to the owner / designer

1. **Brand fork — which primary wins? (blocking for the brand token.)** Two
   primaries coexist and **both currently render**: shadcn `--primary` is teal
   (`globals.css:57`, drives `components/ui/*` like `Button` default + focus ring)
   and `--primary-partner` is navy (`globals.css:111`, drives the `.btn-primary`
   global class + `.input:focus`). The 3-tier `--brand` must resolve to ONE. My
   recommendation is **navy** (`#0b2545` — institutional, trustworthy, and already
   the partner's intended brand), but this is the designer's call. It is a
   one-token change once decided.

2. **`statusColor` migration — clean now, or shim? (scopes the StatusPill slice.)**
   Either (a) migrate the VM type + 6 adapters + 3 specs to semantic intent now
   (clean; removes the leak at its root; the slice in §4.5), or (b) leave the
   adapters emitting `amber|emerald|red|gray` and add a literal→intent mapping
   only inside `StatusPill` (cheaper, but the leak persists in the VM type and
   the next adapter author re-introduces it). I recommend (a).

3. **Warmth knob — how warm?** Whether to nudge `--bg-surface`/`--bg-app` toward
   paper-off-white now (§2.1) or leave the current cool slate and let the
   designer set it in the first re-skin. Either is a pure token-value change.

4. **(Adjacent, not visual — flagged for completeness.)** The `ThresholdProgress`
   headline % can be **legally wrong** because consent ignores
   `ownerships.share_numerator/denominator` (`00-MASTER-PLAN.md §2.2`). The visual
   component is built to render whatever weighted % the backend supplies; the
   *counting rule* is a domain decision + a separate backend slice. Surfaced so
   the visual layer isn't held responsible for a data-correctness bug.

---

## 8. Recommended sequencing (non-binding)

1. **Add the Tier-2 semantic block** to `globals.css` + the semantic mappings in
   `tailwind.config.ts` (§3.2/§3.3). Additive; breaks nothing; ratchet green.
   **Includes defining the missing `card` token (§1.8) and fixing the `--r-lg`
   fork (§1.4) — two shipping bugs closed in this step.**
2. **Add the spacing + type scales** (the two real gaps, §1.2/§1.5).
3. **Resolve the brand fork** (§7.1) — a one-token change once the owner decides.
4. **Re-home `StatusPill` + `Button.destructive`** onto semantic tokens via the
   §4.5 migration (VM type → 6 adapters → 3 specs → component); add the
   default-palette lint guard (§5.4).
5. **Build the E2 hero components** (§4) on the semantic layer; lower the
   inline-color ratchet baseline as each lands.
6. **Validate with ONE screen first** (E2.1 home) in real Chrome against the
   North Star, then expand. The data layer is never touched → safe + reversible.

---

## 9. Cross-references

- North Star rubric: `docs/DESIGN-NORTH-STAR.md`
- Master plan (this pass's siblings + the domain/data findings):
  `docs/design-research/00-MASTER-PLAN.md`
- Token debt + re-skin path (the prerequisite argument):
  `docs/ARCHITECTURE-fe-design-tokens.md`
- Per-org branding spine: `docs/ARCHITECTURE-per-org-configurable-policy.md §B`
- RTL / Heebo / NameDisplay rules: `apps/web/CLAUDE.md`
- The inline-color ratchet (and its blind spots):
  `apps/web/src/app-no-new-inline-colors.spec.ts`
- Tokens today: `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts`
- Leak source (data layer): `apps/web/src/models/project.vm.ts:28`,
  `apps/web/src/adapters/{project,apartment,signature-request,task,import,portal}.ts`
- Leak surface (components): `apps/web/src/components/ui/{status-badge,button}.tsx`
- Re-usable chrome: `apps/web/src/components/ui/{list-page-shell,list-skeleton,confirm-dialog,name-display}.tsx`
