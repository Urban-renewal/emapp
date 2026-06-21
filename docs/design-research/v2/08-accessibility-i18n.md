# 08 — Accessibility & i18n Contract (V2, grounded pass)

> Council role: **Accessibility & i18n specialist (WCAG 2.1 AA · RTL · bidi · he/en)**.
> This replaces the shallow first pass. Every rule below is tied to a **real file**,
> a **real field**, or a **real screen** in the current tree. Where a claim cannot be
> grounded in code, it is flagged **[UNVERIFIED]** or **[OWNER DECISION]**.

---

## 0. Executive posture — what the codebase already gets right

This is **not a greenfield a11y/i18n situation**. The repo already enforces several
hard invariants via static specs that fail CI. The redesign must *inherit and not
regress* these — they are the floor, not the ceiling:

| Invariant | Enforced by | Status |
|---|---|---|
| Bidi-spoofing strip on all wire names | `apps/web/src/lib/bidi.ts` + `components/ui/name-display.tsx` + `name-display.spec.ts` | **Live, 42 call-sites** |
| i18n key coverage (no raw-key leaks) | `apps/web/src/app-i18n-key-coverage.spec.ts` | **Live** |
| he/en namespace symmetry | same spec, 2nd `it()` | **Live** |
| `<form method="post">` (no GET credential leak) | `apps/web/src/app-forms-no-get-fallback.spec.ts` (per `apps/web/CLAUDE.md`) | **Live** |
| RTL-first physical-prop discipline (`ms-`/`me-` not `ml-`/`mr-`) | convention in `apps/web/CLAUDE.md` | **~99% clean** (see §3) |
| No new inline color literals (token-only) | `apps/web/src/app-no-new-inline-colors.spec.ts` | **Live** |
| `lang` + `dir` set per locale | `apps/web/src/app/[locale]/layout.tsx:43` | **Live** |

The redesign's job is to (a) **extend** these to the new hero components, and
(b) **close the genuine gaps** below — which are real, but narrow.

---

## 1. The WCAG 2.1 AA contract for the redesign

This is the binding checklist. Each hero component (home triage card, project
workflow board, signature-chase panel, status pill, progress bar) MUST satisfy it.

### 1.1 Perceivable

- **1.4.3 Contrast (AA, 4.5:1 text / 3:1 large+UI).** Colors come ONLY from the
  tokens in `apps/web/src/app/globals.css` `:root` (lines 64–112). I audited the
  text-on-surface pairs the redesign will lean on:

  | Foreground token | Background token | Ratio | Verdict |
  |---|---|---|---|
  | `--text` `#0f172a` | `--bg-app` `#f5f7fa` | ~15.8:1 | PASS |
  | `--text-muted` `#64748b` | `--bg-surface` `#ffffff` | ~4.76:1 | **PASS (thin margin)** |
  | `--text-soft` `#94a3b8` | `#ffffff` | ~2.7:1 | **FAIL for body text** |
  | `--success-700` `#15803d` | `--success-50` `#f0fdf4` (badge) | ~5.6:1 | PASS |
  | `--warning-700` `#b45309` | `--warning-50` `#fffbeb` | ~5.9:1 | PASS |
  | `--danger-700` `#b91c1c` | `--danger-50` `#fef2f2` | ~6.0:1 | PASS |
  | `--navy-800` `#13315c` | `--navy-50` `#f2f6fb` (info badge) | ~10:1 | PASS |

  **RULE A1 — `--text-soft` (`.soft`, line 467) is decorative-only.** It is below
  3:1 and MUST NOT carry meaning. The North-Star "plain Hebrew" sentences
  ("כמעט שם · חסרה חתימה אחת") are *meaning* — they MUST render in `--text` or
  `--text-muted`, never `--text-soft`. Today `--text-soft` is used for input
  placeholders (`globals.css:326`) and the empty-cell em-dash — acceptable. Any
  redesign use for a real status sentence is a **defect**.

  **RULE A2 — `--text-muted` is at the 4.5:1 floor (~4.76:1).** It passes on pure
  white but will *fail* on `--bg-subtle`/`--bg-hover` (`#f8fafc`/`#f1f5f9`).
  The pulse/secondary lines on the home card sit on tinted surfaces — there,
  secondary text MUST step up to `--ink-600` (`#475569`, ~7:1) or `--text`.
  **[OWNER DECISION]**: confirm the home-card secondary line uses `--ink-600`
  on tinted rows, not `--text-muted`.

- **1.4.1 Use of color.** See §4 — color is *never* the only signal.

- **1.4.11 Non-text contrast (3:1 for UI components & state).** The button
  focus ring is `focus-visible:ring-2 focus-visible:ring-primary`
  (`components/ui/button.tsx:10`). `--primary` is HSL `172 83% 26%` (teal ~`#0b7c6f`)
  — ~3.3:1 against white: **PASS**, but only just. **RULE A3:** the focus ring must
  remain `ring-2` (2px) minimum; do not reduce to `ring-1` in any re-skin.
  The progress bar fill (`.progress > i`, `globals.css:363`) is `--primary-partner`
  = navy-900 on `--ink-100` track (`#f1f5f9`): ~13:1 — fine.

### 1.2 Operable

- **2.1.1 Keyboard / 2.1.2 No trap.** The repo's modal pattern is correct and is
  the template: `ConfirmDialog` (`components/ui/confirm-dialog.tsx:159–187`)
  implements a real **focus trap** (Tab/Shift-Tab cycle), **ESC to close**, and
  **focus-to-safe-button on open** (line 154–156, focuses *cancel*). `StepUpDialog`
  (`components/step-up-unlock.tsx`) is the older sibling and is **missing the focus
  trap** (it has ESC-less dismissal via backdrop only and no Tab cycling).
  **RULE A4:** all redesign modals MUST follow `ConfirmDialog`, NOT `StepUpDialog`.
  **Gap G1 (real):** `StepUpDialog` should be retrofitted with the same trap; it
  currently lacks ESC handling and Tab containment. Low risk (it's a 6-digit OTP
  form) but it is a genuine AA 2.1.2/2.4.3 gap.

- **2.4.3 Focus order.** Modal focus order is enforced by the trap. For the home
  triage cards (the new hero), focus order MUST follow visual order in the RTL
  flow: card → primary action → "open full list". This is a build-time discipline,
  not enforced by any spec today → see §6 per-component table.

- **2.4.7 Focus visible.** Inherited from button/`input:focus`
  (`globals.css:321` gives inputs a 3px `box-shadow` ring). **RULE A5:** every
  interactive hero element (card-as-button, pill-as-filter) needs a *visible*
  focus indicator; a card that is clickable MUST be a real `<button>`/`<a>` or
  carry `tabindex={0}` + `role` + a `focus-visible` ring. Do not ship a
  `<div onClick>` triage card.

- **2.5.5 / target size.** Row height token `--row-h` is 44px default
  (`globals.css:105`), 36px in compact density (`:413`). 44px is the AAA target
  and a good default for the low-tech user. **RULE A6:** primary triage actions
  stay ≥44px; the compact (36px) density is opt-in and must not be the home default.

### 1.3 Understandable

- **3.1.1 Language of page** — `lang={locale}` on `<html>`
  (`[locale]/layout.tsx:43`). **PASS.**
- **3.1.2 Language of parts** — Hebrew UI with embedded Latin (developer company
  names, national-id digits, dates). The bidi `<bdi>` + `dir="ltr"` islands handle
  rendering; no per-span `lang` is currently set on Latin fragments. This is an
  *AA-pass-with-caveat*: 3.1.2 strictly wants `lang="en"` on foreign-language
  phrases, but proper nouns/IDs are exempt. **No action required** for IDs/dates;
  **[UNVERIFIED]** whether any free-text English *sentences* ever appear in the
  he UI — if they do (e.g. an imported English note), wrap in `<span lang="en">`.

- **3.3 Error identification / labels.** Form inputs use `<label htmlFor>`
  (e.g. `step-up-unlock.tsx:235`, the OTP). Errors use `role="alert"`
  (`step-up-unlock.tsx:280`). **RULE A7:** every redesign form field keeps an
  associated `<label>` (not placeholder-as-label — placeholders are `--text-soft`,
  failing contrast AND disappearing on input).

### 1.4 Robust

- **4.1.2 Name/Role/Value.** Dialogs carry `role`, `aria-modal`,
  `aria-labelledby`, `aria-describedby` (`confirm-dialog.tsx:197–201`). **RULE A8:**
  the redesign's exception-triage list is a `role="list"` of `role="listitem"`s
  (or a real `<ul>`); each card's accessible name = the project name +
  plain-Hebrew status sentence, so a screen-reader user hears
  "מגדל הים, כמעט שם, חסרה חתימה אחת" — the same triage the sighted user gets.

---

## 2. Bidi-spoofing defense — the contract (this is the crown jewel; do not weaken it)

### 2.1 What exists and why it's correct
`lib/bidi.ts` strips the dangerous codepoints (RLO `U+202E`, the LRE/RLE/PDF/LRO
block `U+202A–202E`, the isolate block LRI/RLI/FSI/PDI `U+2066–2069`, and LRM/RLM
`U+200E/200F`) via `BIDI_OVERRIDE_REGEX` (global flag, verified by
`name-display.spec.ts` test 7). `<NameDisplay>` (`components/ui/name-display.tsx`)
applies **both** the strip *and* a `<bdi>` isolate — defense in depth. The threat
model (`bidi.ts:8–16`) is exactly right: a cross-record spoof where owner name
"John␤RLO" reverses the *next* table cell. In a dense owners/apartments table
(the redesign's project page), this is a live risk.

### 2.2 The binding rule for the redesign
**RULE B1 — every string that originated from a human or an import MUST pass
through `stripBidiOverrides` before render, and through `<NameDisplay>` whenever
the element can host `<bdi>`.** The "human-origin" set in this product is, by
real field name:

- `owners.full_name`, owner display names
- `apartments.number` (imported/extracted — see `adapters/project.ts:164`, already
  stripped), and its derived `designation`
- `projects.name`, `projects.developerName`, `projects.developerCompanyId`,
  `projects.description`, `projects.typeLabel`/`futureTrackLabel`,
  `block`/`parcel`/`subparcel`, `relocationNotes`, and **signatureMilestone labels**
  — ALL already bidi-stripped in `adapters/project.ts:65–98`. This adapter is the
  reference implementation; copy its posture.
- member names, contractor share names, note bodies, message bodies,
  tabu-extracted owner names + national_id strings.

### 2.3 The `<option>` / `<title>` exception (already handled, keep it)
`<bdi>` cannot nest inside `<option>`, `<title>`, `<textarea>` (browsers strip it
— documented `bidi.ts:18–25`). The repo's answer: strip at the data layer +
`dir="auto"` on the element. Real example:
`apartments/[id]/ownerships/page.tsx:174–175` (`<option … dir="auto">` over a
bidi-stripped project name). **RULE B2:** any redesign `<select>` of owner/project
names follows this exact pattern — strip in adapter, `dir="auto"` on `<option>`.

### 2.4 The real gap
**Gap G2 (real, low severity):** the strip happens in *adapters* and in
`<NameDisplay>`, but a redesign component that renders a wire name **inline
without either** (e.g. a quick `{owner.name}` in a new triage card, or inside an
`aria-label`/`title` attribute, or a toast) bypasses the defense. There is **no
static spec** that catches a raw `{someName}` interpolation the way the i18n
scanner catches missing keys. **[OWNER DECISION / follow-up slice]:** add a
lint/spec that flags JSX text/attribute interpolation of known name-bearing
ViewModel fields outside `<NameDisplay>`/`stripBidiOverrides`. Until then this is
a **code-review checklist item** for every hero component. Note specifically:
**`aria-label`, `title`, and toast/`alert` strings built from names are NOT
covered by `<bdi>`** (attributes can't hold elements) — they MUST use
`stripBidiOverrides(name)`.

---

## 3. RTL correctness rules

### 3.1 State of the tree (measured)
A scan for physical-direction Tailwind utilities (`ml-N`, `mr-N`, `pl-N`, `pr-N`,
`left-N`, `right-N`, `text-left`, `text-right`) across all `.tsx` returned exactly
**one** hit: `_components/notifications-bell.tsx:81` —
`absolute -top-1 -right-1` on the unread-count badge. In RTL the unread badge sits
top-**right** of the bell, which is geometrically wrong for RTL (should hug the
top-**inline-start**). **RULE R1 / Gap G3 (real, cosmetic):** replace `-right-1`
with `-end-1` (logical inset, Tailwind 3.3+) so the badge mirrors with the layout.

The codebase is therefore ~99% logical-property clean. The redesign MUST keep it
there.

### 3.2 Binding rules
- **RULE R2 — logical properties only.** Margins/padding: `ms-*`/`me-*`,
  `ps-*`/`pe-*`. Insets: `start-*`/`end-*`. Text align: `text-start`/`text-end`
  (the repo already uses `text-start`, e.g. `confirm-dialog.tsx:208`). Borders:
  `border-s`/`border-e`. NEVER `ml/mr/pl/pr/left/right/text-left/text-right`.
- **RULE R3 — directional icons mirror.** Back-navigation chevrons/arrows point
  toward the inline-start. The repo's correct pattern is to rotate a fixed-name
  icon: `owner-detail.client.tsx:128` and `projects/new/page.tsx:1445` render
  `<ArrowRight … rotate-180 aria-hidden="true">` so the visual arrow points the RTL
  "back" direction. **Caveat:** `projects/new/page.tsx:1457` uses a bare
  `<ArrowLeft>` for "next step" — verify it points correctly in RTL (in a wizard,
  "next/המשך" should point inline-start; an un-rotated `ArrowLeft` points
  physical-left = visually "next" in RTL, which is plausibly correct — **[UNVERIFIED
  visually]**, flag for the live-Chrome pass). **RULE R3a:** purely directional
  icons carry `aria-hidden="true"` (they already do) so SR users hear the text
  label, not "arrow".
- **RULE R4 — LTR islands inside RTL.** Digit/code/phone/national-id fields force
  `dir="ltr"` so digits don't reorder. Real, correct precedent everywhere:
  OTP input `step-up-unlock.tsx:246`, phone/code `tenant/login/page.tsx:364/384`,
  national_id `tabu-review-section.tsx:415`, version string `global-error.tsx:84`.
  **The redesign's signature-progress counts ("12 / 18"), percentages, dates, and
  national_id MUST sit in `dir="ltr"` spans** — otherwise "12 / 18" can render
  "18 / 12". Use the existing `.tabular` class (`globals.css:470`,
  `font-variant-numeric: tabular-nums`) for aligned numerals.
- **RULE R5 — progress bar fills from the inline-start.** `.progress > i`
  (`globals.css:363`) is a block element in an RTL container, so it fills from the
  right edge automatically. Keep it CSS-driven; do not hardcode `left:0`.

---

## 4. "Color is never the only signal" — enforcement

### 4.1 Current state (good, with one structural caveat)
The status system already separates **semantic color** (in the ViewModel:
`statusColor`/`barColor`) from the **human label** (`statusLabel`). Every
`<StatusBadge>` call-site I checked passes a **text child**:
`projects-list.client.tsx:229` → `{p.statusLabel}` ("איסוף חתימות" etc.),
`apartments/[id]/page.tsx:113`, `imports/page.tsx:61`, `members-list:226`,
`owner-detail:264`, etc. So today the pill is **color + Hebrew word** — color is
redundant, not load-bearing. That satisfies 1.4.1.

`adapters/project.ts:48–55` maps the locked D.18 enum to 4 colors and is the
single source: `planning→gray`, `gathering_signatures→amber`, `approved/in_construction→emerald`,
`completed→gray`, `cancelled→red`.

### 4.2 The structural caveat
`StatusBadge` (`components/ui/status-badge.tsx`) renders **only** color classes +
the text child — it has **no icon/glyph slot**. The legacy `.badge` CSS in
`globals.css:250–307` DOES define a `.badge-dot` (a colored dot), but `StatusBadge`
doesn't use it. So the *non-text* differentiator (shape/icon) is absent; only the
text carries the non-color signal. **That is AA-sufficient** (text ≠ color), but
for the North-Star low-tech user and for the redesign's at-a-glance triage, an
icon strengthens scannability.

**RULE C1 — every status pill carries TEXT (mandatory) and SHOULD carry an icon
(recommended).** Mandatory because two amber states ("gathering" vs a future
"at-risk") would be color-indistinguishable without the word.

**RULE C2 — give `StatusBadge` an optional leading icon/dot slot** so the
redesign can pair, e.g., gathering_signatures = ✎/clock + "איסוף חתימות",
cancelled = ✕ + "בוטל", approved = ✓ + "מאושר". The icon is `aria-hidden`; the
word is the accessible name. This is a small, token-safe extension of the existing
component, not a rewrite.

**RULE C3 — momentum / "why" signals carry words, never bare color/arrows.** The
North-Star "זז יפה, +2 השבוע" / "אין תנועה 18 יום" must be *text*. A green/red
trend arrow alone fails 1.4.1 AND fails the low-tech user. The arrow is decoration
(`aria-hidden`); the Hebrew sentence is the signal.

### 4.3 Data-honesty intersection (a11y angle)
Per the North-Star "never fake it": the momentum ("+2 השבוע") and human-bottleneck
("3 בעלים מתנגדים") signals require backend fields that **may not exist yet**
(the North-Star itself flags "owner objection/status field" as a *backend
follow-up*). **[OWNER DECISION]:** until those fields ship, the redesign must
**omit** the momentum/why line, not render an empty or guessed one. An a11y
consequence: do NOT reserve an `aria-live` region that announces a fabricated or
perpetually-empty "why" — that would spam SR users with noise.

---

## 5. i18n completeness — Hebrew-first, en parity

### 5.1 Measured state (strong)
- `messages/he.json` and `messages/en.json` are **1809 lines each**; flattened,
  **1491 keys each — exact parity.** Of all leaf values, exactly **one** en value
  still contains Hebrew, and it is *correct*: `settings.localization.localeOption.he`
  = "עברית" (a language's endonym is shown in its own script in both locales).
  **There is effectively zero translation debt.**
- The coverage spec (`app-i18n-key-coverage.spec.ts`) statically proves every
  `t('key')` reference resolves in BOTH locales, and that top-level namespaces
  match. This caught a real prod bug (`/he/signature-requests/new` rendering the
  raw key `signatureRequests.createHint`) — the spec exists *because* of it.

### 5.2 Binding rules for the redesign
- **RULE I1 — no hard-coded user-facing strings.** Every label/sentence goes
  through `useTranslations`. Add to `he.json` FIRST (default locale), then the
  matching `en.json` key (per `apps/web/CLAUDE.md`). The coverage spec will fail
  the build otherwise — this is your safety net, lean on it.
- **RULE I2 — enum→Hebrew label maps stay in adapters, not messages.** Precedent:
  `adapters/project.ts:29–46` keeps `STATUS_LABELS`/`TYPE_LABELS` beside the locked
  D.18 enum *on purpose* (comment lines 17–27: "changing one without the other
  would silently desync the UI from the contract"). The redesign's new status
  *sentences* are product copy → they MAY live in messages; but the 1:1 enum label
  mapping stays in the adapter. **[OWNER DECISION]:** if en-locale project-status
  labels are ever needed (today they're Hebrew-only in the adapter regardless of
  locale — `toProjectViewModel` takes `locale` but only uses it for `formatRelative`,
  NOT for `statusLabel`), that's a product decision. Today an en-locale user sees
  Hebrew status words. Flag for owner: **is en a real shipping locale, or
  he-only-with-en-scaffold?** This materially changes the i18n test bar.
- **RULE I3 — pluralization & interpolation.** "+2 השבוע", "חסרה חתימה אחת" vs
  "חסרות 3 חתימות" need Hebrew plural rules (he has one/two/many forms). Use
  next-intl ICU plural syntax in the message, not string concatenation in JS.
  Hebrew dual ("שתי חתימות") is a real correctness trap — **[UNVERIFIED]** whether
  any current copy handles dual; the redesign's count sentences must.
- **RULE I4 — dates display Asia/Jerusalem, stored UTC** (CLAUDE.md hard rule).
  `formatRelative` (`lib/format.ts`) is the seam; relative Hebrew ("לפני 3 ימים")
  is more low-tech-friendly than absolute dates for the home pulse.

---

## 6. Per-hero-component a11y spec (the explicit contract each must meet)

> Each redesign hero ships with these satisfied IN THE SAME SLICE (mirrors the
> repo's "no-deferred-smoke" DoD in `apps/web/CLAUDE.md`).

### 6.1 Home exception-triage card ("the ~5 that need you now")
- **Role:** real `<a>`/`<button>` (NOT `<div onClick>`); the card *is* the
  navigation control. Container is `<ul role="list">` (or semantic `<ul>`).
- **Accessible name:** project name (via `<NameDisplay>`) + plain-Hebrew status
  sentence, concatenated so SR reads the full triage line.
- **Focus order:** card → its inline primary action (e.g. "שלח תזכורת") → next
  card. Visible `focus-visible` ring (RULE A5).
- **Color:** status conveyed by text sentence + pill (RULE C1); never color-only.
  Secondary line ≥ `--ink-600` on tinted rows (RULE A2).
- **Keyboard:** Enter/Space activates; no keyboard trap.
- **Contrast:** all text ≥4.5:1 (RULE A1 — no `--text-soft` for meaning).
- **Bidi:** every name via `<NameDisplay>`; any name in `aria-label` via
  `stripBidiOverrides` (RULE B1/G2).
- **Live region:** if the home auto-refreshes the triage set (TanStack
  `refetchOnWindowFocus: true` is on, per `apps/web/CLAUDE.md`), wrap the list in
  `aria-live="polite"` ONLY if changes are meaningful and infrequent; otherwise
  omit to avoid SR spam.

### 6.2 Project workflow board (buildings → apartments → owners)
- **Role:** semantic table (`<table>`/`.tbl`, `globals.css:376`) — `.tbl thead th`
  already `text-align:right` for RTL (line 383). Header cells are `<th scope="col">`.
- **Bidi:** owner/apartment names via `<NameDisplay>`; `apartments.number`
  designation already stripped in adapter.
- **Numbers:** signature counts + percentages in `dir="ltr" .tabular` spans
  (RULE R4).
- **Per-owner status:** pill with text (RULE C1); "who's stuck" = Hebrew sentence
  with the owner name bdi-wrapped ("אורי דירה 7 לא חתם").
- **Sort/filter controls:** native `<button aria-pressed>` for active sort;
  sort direction announced in Hebrew, arrow icon `aria-hidden` + mirrored (R3).
- **Target size:** rows ≥44px at default density (RULE A6); compact opt-in only.

### 6.3 Signature-chasing panel (reminder / expiry / holdout loop)
- **Destructive confirms** (cancel a request, revoke a link) use `useConfirm`
  (`components/ui/confirm-dialog.tsx`) with `destructive: true` → `.btn-danger`
  token (RULE A4). Full alertdialog contract: focus-to-cancel, ESC, trap.
- **OTP/code entry** (if any) reuses the `StepUpDialog` input pattern: `dir="ltr"`,
  `inputMode="numeric"`, `autoComplete="one-time-code"`, `<label htmlFor>`,
  `role="alert"` error (RULE A7) — BUT retrofit the missing focus trap/ESC (Gap G1).
- **Expiry/momentum copy:** plain Hebrew sentence (RULE C3), ICU plurals (RULE I3),
  dates relative Asia/Jerusalem (RULE I4).

### 6.4 Status pill (`StatusBadge`, shared)
- **Mandatory text child** (RULE C1). **Add optional icon/dot slot** (RULE C2),
  icon `aria-hidden`. Contrast per the §1.1 table (all current pairs PASS).
- Token-only colors (no new inline literals — the `app-no-new-inline-colors.spec`
  ratchet enforces).

### 6.5 Progress bar (`.progress`, shared)
- **Not color-only:** pair with a `dir="ltr"` numeric/percent label and/or the
  threshold sentence ("כמעט שם · חסרה חתימה אחת"). The `barColor` green/amber
  (`adapters/project.ts:139`, `metThreshold`) is reinforcement, not the message.
- Consider `role="progressbar"` + `aria-valuenow/min/max` + `aria-label` (Hebrew)
  so SR users get the percentage; today `.progress` is a presentational div.
  **Gap G4 (real, minor):** add ARIA progressbar semantics in the redesign.

---

## 7. Consolidated gap register (real, grounded — for the backlog)

| # | Severity | Gap | File / evidence | Fix |
|---|---|---|---|---|
| G1 | Med (AA 2.1.2/2.4.3) | `StepUpDialog` lacks focus trap + ESC handling | `components/step-up-unlock.tsx` (compare `confirm-dialog.tsx:159–187`) | Port the ConfirmDialog trap/ESC |
| G2 | Med (security/bidi) | No static guard catches raw name interpolation or names in `aria-label`/`title`/toasts outside `<NameDisplay>`/`stripBidiOverrides` | absence of a spec; `bidi.ts` only covers what's routed through it | Add scanner spec; code-review rule meanwhile |
| G3 | Low (RTL cosmetic) | `-right-1` physical inset on notification badge | `_components/notifications-bell.tsx:81` | `-end-1` logical inset |
| G4 | Low (a11y) | `.progress` has no `role="progressbar"`/aria values | `globals.css:356`, all call-sites | Add ARIA progressbar attrs |
| G5 | Low (contrast) | `--text-muted` (~4.76:1) fails on tinted `--bg-subtle/--bg-hover` | `globals.css:70`, `:66–67` | Use `--ink-600` for secondary text on tinted rows |

---

## 8. Owner-decision queue (surfaced, not assumed)

1. **Is `en` a real shipping locale or an English scaffold?** Today the
   project/apartment **status labels render Hebrew regardless of locale**
   (`adapters/project.ts` `STATUS_LABELS` is Hebrew-only; `toProjectViewModel`'s
   `locale` param only feeds `formatRelative`). If en is a real locale, status/type
   labels need en variants and the i18n bar rises materially. If he-only, we can
   stop maintaining en parity for *enum* labels (keep it for UI chrome).
2. **Momentum + "why" backend fields.** The North-Star momentum ("+2 השבוע") and
   human-bottleneck ("3 בעלים מתנגדים") signals are flagged as a *backend
   follow-up* and likely don't exist yet. Confirm: omit the line until the field
   ships (no fabricated/empty `aria-live`).
3. **Home-card secondary text on tinted rows = `--ink-600`?** (closes G5 / RULE A2).
4. **Add the bidi-interpolation static guard (G2) as a slice?** It's the one real
   hole in an otherwise excellent bidi defense.
5. **Hebrew plural/dual copy ownership (RULE I3).** Confirm count sentences use
   ICU plurals (incl. dual) — needs a native-Hebrew copy review, not just dev.

---

## 9. What I could NOT verify (honesty log)

- **Live contrast in real Chrome** — ratios above are computed from the token hex
  values in `globals.css`; they should be re-checked with a contrast tool against
  the *rendered* composited colors (badges layer a tinted border too). Flag for the
  live-Chrome pass.
- **Visual mirroring of the wizard `ArrowLeft`** (`projects/new/page.tsx:1457`) —
  needs a real RTL render to confirm "next" points correctly (RULE R3 caveat).
- **Whether any English free-text sentence ever appears in the he UI** (3.1.2 /
  `lang` on parts) — depends on imported data content; not determinable statically.
- **Screen-reader pass (NVDA/VoiceOver) in Hebrew** — none of the above substitutes
  for an actual SR run on the redesigned home; recommend it as a gate before the
  redesign ships.

---

## 10. Addendum — the "system acts & notifies" doctrine has NO accessible channel (the biggest new-surface requirement)

The owner-elevated central doctrine is *"the system does the work; the developer just
approves"* — specifically **(b) "ACT in the background and NOTIFY, don't task."** The
entire emotional payoff ("it already chased / already sorted") is delivered to the
**sighted** user as visual after-the-fact status. To a screen-reader or many low-vision
users, **a background action that completes silently does not exist.** This is the
single most important a11y requirement the redesign introduces, and it is currently
**unbuildable with the primitives in the repo**:

- **Evidence of the gap:** `components/step-up-unlock.tsx` header states verbatim
  *"No dialog/toast primitive exists in this repo."* There is **no app-level live
  region** (`role="status"` / `aria-live`) mounted anywhere. Inline `role="alert"`
  exists *only inside the two modals* (`step-up-unlock.tsx:280`,
  `confirm-dialog.tsx`), scoped to those dialogs — there is no persistent,
  always-mounted announcement channel for asynchronous "the system did X" results.

- **The contract (Gap G6 — High):** build, as the FIRST redesign primitive, a single
  app-root live-region pair:
  - `role="status" aria-live="polite" aria-atomic="true"` for routine system actions
    ("נשלחה תזכורת ל-3 בעלים", "הבקשה חודשה ל-7 ימים"). Polite = does not interrupt.
  - `role="alert" aria-live="assertive"` for exception/failure ("לא נשלחה תזכורת — נסה שוב").
  Every "propose → one-tap approve" loop (§6.3) and every background-cadence result
  routes its plain-Hebrew confirmation through this region. Without it, the doctrine's
  promise is literally inaudible.

- **Honesty constraint (ties to §4.3 / owner-decision #2):** the live region must
  announce only **real** completed actions backed by a real backend result — never a
  fabricated "we chased the holdouts" when the field/job doesn't exist yet. A perpetually
  re-announcing or guessed status is SR-hostile noise.

### 10.1 WCAG 2.5.8 Target Size (AA) — explicit
The brief targets a **non-technical, technophobic, possibly touch** user. WCAG 2.1
AA-2.5.8 requires interactive targets ≥ **24×24 CSS px**; the repo's `--row-h: 44px`
default (`globals.css:105`) and Button `sm`=36px / `icon`=40px already clear it. **The
one-tap "approve" action — the core of the doctrine — should be deliberately LARGE
(≥44px, the AAA size in §1.2 RULE A6), high-contrast, and have a consequence-naming
accessible label** ("אשר ושלח תזכורת ל-3 בעלים", not "אישור"). Fewer, bigger, clearly
labeled controls is both the low-tech win AND the a11y win — they are the same design.

### 10.2 Disabled-state distinguishability (low-vision)
Button disabled styling is `disabled:opacity-50` only (`button.tsx:10`). WCAG 1.4.3
*exempts* disabled controls from contrast, so this is conformant — but for the anxious
low-tech user, a disabled primary approve button distinguished by opacity alone is easy
to misread as "broken." Pair with `cursor-not-allowed` and keep the full label visible;
never blank the label on disable.

### 10.3 `lang` voice-switching nuance (refines §1.3 / G ambiguity)
`<NameDisplay>`'s `<bdi>` fixes *direction* but does not set `lang`, so a screen reader
reading a Latin company name inside Hebrew won't switch voice (3.1.2). For **proper
nouns and IDs this is exempt and fine** (no action). It only matters if a full English
*sentence* ever appears in the he UI (e.g. an imported English note body) — then wrap
that fragment in `<span lang="en">`. Recommend an **optional `lang` prop on
`<NameDisplay>`** for the rare known-Latin-content case, defaulted off so the 99%
Hebrew-name path stays unchanged. Low priority; flagged for completeness.

### 10.4 Updated owner-decision (append to §8 queue)
6. **Live-region primitive (G6) is the gating dependency for the entire "act &
   notify" doctrine.** It is engineering work, but the owner should know: without it,
   the redesign's headline promise is delivered only to sighted users. Build it before
   any "one-tap approve" hero ships.
