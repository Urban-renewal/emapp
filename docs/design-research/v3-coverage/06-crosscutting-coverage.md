# 06 — Cross-cutting Coverage Audit (v3)

> **Dimension:** Cross-cutting concerns — auth/session, i18n (he/en), a11y (WCAG AA / RTL /
> bidi / focus-dialog contracts), perf (RSC-prefetch + LCP budget), error/empty/loading
> (DataState), security/PII (validation P0, masking, no-PII-in-URL).
> **Method:** real-code inventory via Glob/Grep + line-level reads, each item cross-checked
> against `v2/00-MASTER-PLAN-V2.md` + `04/06/07/08` + `DECISIONS-LOCKED.md` +
> `CRITIQUE-completeness.md`, and reconciled against `docs/SECURITY-POSTURE.md`.
> **Verdict up front:** the plan's cross-cutting *intent* is strong and mostly grounded, but
> it stands on **three load-bearing factual errors about the real tree** (a `ConfirmDialog`
> that does not exist; a claim that native confirms were already replaced; a richer "import
> DataState taxonomy" framed as more general than it is) and it **never reconciles the
> SECURITY-POSTURE P0/P1/P2 program with the E2 backend slices** — exactly the kind of
> "discover it mid-implementation" surprise the owner wants eliminated.

---

## GAP SUMMARY (ranked by impact on the one-shot goal)

| Rank | GAP | Why it breaks one-shot implementation |
|---|---|---|
| **X1** | **`ConfirmDialog` / `useConfirm` does NOT exist in the repo.** The plan's a11y modal contract (08 §1.2 RULE A4, 08 G1, 06 Finding D.2, M0/M5/M6) is anchored to `components/ui/confirm-dialog.tsx:159–187` as the "gold-standard alertdialog with ESC + focus trap + focus-to-cancel." `find` returns nothing; no git history. The **only** real modal is `StepUpDialog`. So M0 ("follow the ConfirmDialog contract NOT StepUpDialog"), M5 ("wrap the campaign in the ONE justified ConfirmDialog"), M6 ("retrofit StepUp to the ConfirmDialog contract"), and the 08 a11y template all reference a non-existent file. **Building the alertdialog primitive is net-new work the plan budgeted as "already exists, just copy it."** |
| **X2** | **Destructive confirms today are 17× native `window.confirm()`, not a component.** 06 Finding D.5 / `confirm-dialog.tsx` header is quoted as "it replaced ~18 native-confirm call-sites." It did not — `grep window.confirm` = 17 live sites (apartments, buildings, contractors, documents, imports, members, notes, owners, assignments, project-detail). The redesign's "undo over confirm" doctrine must **migrate 17 native confirms** (an a11y + RTL + i18n surface each — native `confirm()` is unstyled, untranslated, LTR-chrome) — a real, uncounted slice. |
| **X3** | **SECURITY-POSTURE P0/P1/P2 is not reconciled with the E2 roadmap at all.** Zero references to `SECURITY-POSTURE.md`, the global `APP_PIPE` (P0.1), the `input-validation-coverage` CI guard (P0.2), magic-byte (P0.4), or `.strict()` query schemas (P1.1) across any v2 doc. Yet E2 ships **four new BE slices** (B1 pulse, B2 `decline_reason` migration, B4 PII-authz holdout read, S4 search endpoint) — each a new `@Body`/`@Query` surface that, absent P0.1/P0.2, relies on per-endpoint convention. The redesign should fold P0.1+P0.2 into Wave 0 so the new endpoints land *by construction*, not discipline. |
| **X4** | **The "15-min access-token TTL UX" the mandate names has no plan and no surface — and that is arguably correct, but it is undocumented.** The api-client does **single-flight silent refresh on `token_expired`** (`api-client.ts:84–132`) — transparent, no countdown, no "session expiring" warning. The plan never mentions session-expiry UX. For a low-tech anxious user a *silent* mid-action refresh is the right call, but the plan should say so explicitly (and confirm the chase-loop optimistic flip survives a refresh-replay — a dropped POST mid-refresh must not show "נשלחה תזכורת"). Ties to C4 offline. |
| **X5** | **The Provider access-reason gate is per-SESSION (sessionStorage), not per-request, and the redesign never touches the provider tier.** `access-reason-gate.tsx:52–53` reads `sessionStorage` once on mount. 07 §0 explicitly scopes the provider console OUT. The mandate asks about "the access-reason gate" — it is **AS-IS** but the plan should state that the Provider surface (PCSidebar, audit, onboard, tenant-suspension) is deliberately untouched, or it becomes a "missed screen." |
| **X6** | **`en` is not a real shipping locale and the plan leaves it OPEN (OD-5) while sequencing slices that assume it.** `adapters/project.ts:39,74` — `STATUS_LABELS` is Hebrew-only; `toProjectViewModel(p, locale)` uses `locale` ONLY for `formatRelative`. An `/en` user sees Hebrew status words today. Every E2 slice that adds a status sentence / pill copy inherits this. If the owner later says "en is real," the i18n bar rises across **every** redesigned surface — a week-of-patching risk the one-shot goal exists to kill. **Force the decision in Wave 0.** |
| **X7** | **G-MOTION-PERF: the perf baseline (warm 200ms LCP; Heebo @ 3 weights for LCP, PR #47) is named as a risk but never turned into a gate.** M3 animates the hero number on every home load; §7 of the master plan flags "reconcile motion with the perf baseline before shipping count-up" but no slice owns a measured LCP check. The redesign also keeps `'use client'` islands (07 §1.4, accepted debt) — so the home stays a client-hydrated waterfall; layering count-up + ActionToast mount on top, unmeasured, can regress the budget the perf program won. |
| **X8** | **No app-root live-region exists; G6 is correctly identified but its FUSION with the (non-existent) ConfirmDialog contract compounds X1.** Confirmed: no `role=status`/`aria-live` mounted at app root (only scoped inline lines + ListPageShell's per-list `role=status`). The plan's M0 "build ONE live-region that is both ActionToast and G6" is right — but it says to build it "to the ConfirmDialog a11y contract," which doesn't exist (X1). The live-region itself is greenfield and gating for the whole "act & notify" doctrine. |
| **X9** | **`formatRelative` tz bug (P-TZ-1) is correctly planned, but it is ALSO the i18n/dual-plural seam (RULE I3) and the plan splits ownership.** `format.ts:16–30` pins no tz (confirmed); 18 adapters depend on it. The plan fixes tz (Wave 0 P-TZ-1) but Hebrew dual/plural ("שתי חתימות") is left "[UNVERIFIED] / native-copy review" (08 I3, master §7) with no slice. Count sentences are core to the redesign's copy; shipping them with naive `n===1` concatenation is a correctness defect the plan flags but does not schedule. |

Everything below is the exhaustive item-by-item table.

---

## 1. Auth / session

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Single-flight silent refresh on `token_expired` | `lib/api-client.ts:84–132,285–294` | Transparent 15-min access-token rotation; queues concurrent 401s behind one `/auth/refresh` | **AS-IS-OK** | Strong, reuse-detection-aware (drain window). Plan never mentions it → fine to leave, but see X4. |
| 401 terminal vs form-level suppression set | `api-client.ts:301–313` | `invalid_credentials/otp/not_member/invalid_step_up_code` do NOT boot to /login | **AS-IS-OK** | Redesign forms must keep emitting these codes so inline errors stay inline. |
| "15-min TTL UX" (countdown / expiry warning) | — (absent) | Warn before session ends | **GAP (X4)** | No surface; silent refresh covers it. Plan should explicitly bless "no countdown" + verify mid-action refresh-replay doesn't desync optimistic flips. |
| Session seed (zero-`/me` first paint) | `hooks/use-session.ts:17–35`; QueryProvider seed | Role resolved synchronously; backs `useHasPermission` gating | **COVERED** | 07 §1.3 — "the redesign's gating is free." Correct and load-bearing. |
| `useHasPermission` gating (sidebar/CTA) | seeded session → `use-session` | FE capability gate (UX only; BE is the gate) | **COVERED** | Plan's 14→5 sidebar + tab promotion preserve gates (07 §7, master §2.2). Re-verify per-role smoke. |
| Provider access-reason gate (per-session) | `components/provider/access-reason-gate.tsx:43–117` | Blocks `/provider/*` until reason typed; sessionStorage; mirrors BE `withProvider` | **AS-IS / GAP (X5)** | Provider tier scoped OUT (07 §0). State it explicitly or it's a "missed surface." |
| StepUp PII unlock seam | `components/step-up-unlock.tsx:82–122` | `withStepUp` retries a privileged call once after OTP verify | **CHANGED (M6)** | Retrofit planned — but to a contract (ConfirmDialog) that doesn't exist (X1). |
| `getMe()` server double-hop (accepted) | `lib/auth.ts` (per web CLAUDE.md §v9-M-9) | Single env-var contract; +5-15ms/SC render | **AS-IS-OK** | Perf trade documented; redesign shouldn't touch. |

## 2. i18n (he / en parity)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| he.json / en.json key parity | `messages/{he,en}.json` (1813 lines each) | Symmetric namespaces; no raw-key leaks | **COVERED** | 08 §5.1 — exact parity, enforced by `app-i18n-key-coverage.spec.ts`. Lean on it. |
| i18n coverage spec | `app-i18n-key-coverage.spec.ts` | Static proof every `t('key')` resolves in BOTH locales | **COVERED** | Caught a real prod bug; redesign's new copy is auto-guarded. |
| Status labels Hebrew-only regardless of locale | `adapters/project.ts:39,59,74` | `STATUS_LABELS` he-only; `locale` only feeds `formatRelative` | **GAP (X6)** | `/en` renders Hebrew status words. OD-5 left open while slices assume it resolved. |
| Enum→label maps live in adapter (not messages) | `adapters/project.ts:39–46` | D.18 enum + label kept in lock-step | **COVERED** | 08 RULE I2 — keep this; new *sentences* may go to messages. |
| Hebrew dual/plural ("שתי חתימות") | — (no ICU plural in count copy today) | Correct one/two/many forms | **GAP (X9)** | 08 I3 / master §7 flag it; no slice owns it. Redesign's count sentences need ICU plurals. |
| `formatRelative` no-tz | `lib/format.ts:16–30` | "לפני 3 ימים" relative time, 18 adapters | **CHANGED (P-TZ-1)** | Correctly planned in Wave 0. Also the i18n seam (X9). |
| `formatJerusalem` (tz-pinned) | `lib/format.ts:40–50` | Only tz-correct helper; used in provider audit only | **AS-IS-OK** | The model P-TZ-1 should generalize from. |
| `lang`/`dir` per locale | `app/[locale]/layout.tsx:40,43` | `dir='rtl'` for he, `lang={locale}` | **COVERED** | 08 §1.3 — PASS. |
| `create-button` i18n spec | `app-create-button-i18n.spec.ts` | Guards create-CTA copy | **AS-IS-OK** | Sidebar 14→5 must keep create CTAs translated. |

## 3. Accessibility (WCAG AA / RTL / bidi / focus)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| **`ConfirmDialog` (the a11y template)** | **does NOT exist** (`find confirm-dialog.tsx` = ∅) | Plan's cited alertdialog w/ ESC + trap + focus-to-cancel | **GAP (X1)** | The single biggest grounding error. All modal a11y rules reference it. |
| Native `window.confirm()` ×17 | apartments/buildings/contractors/documents/imports/members/notes/owners/assignments/project-detail `[id]/page.tsx` | Actual destructive-confirm mechanism today | **GAP (X2)** | Unstyled, untranslated, LTR — a real a11y/RTL/i18n debt the "undo-over-confirm" slice must migrate. |
| `StepUpDialog` a11y state | `step-up-unlock.tsx:199–291` | `role=dialog`, `aria-labelledby`, NO `aria-describedby`, NO ESC, NO focus trap; backdrop-dismiss | **CHANGED (G1/M6)** | Gap correctly identified; fix target (ConfirmDialog) missing (X1). Also uses dead `bg-card` (:209) + shadcn `text-muted-foreground`/`bg-background` not partner tokens. |
| App-root live-region | — (absent) | `role=status`/`aria-live` for async "system acted" | **CHANGED (G6/M0)** | Greenfield; gating for the whole act-&-notify doctrine. Fusion contract refs X1. |
| `<NameDisplay>` bidi strip + `<bdi>` | `components/ui/name-display.tsx`; `lib/bidi.ts` | RTL-spoof defense, 42 call-sites | **COVERED** | 08 §2 crown jewel. Every hero name must route through it. |
| Bidi interpolation static guard | — (absent) | Catch raw `{name}` / names in `aria-label`/`title`/toast | **GAP (G2)** | 08 §2.4 — no spec exists; code-review-only. New triage cards + omnibox dropdown + toasts are the exact risk. |
| `-top-1 -right-1` physical inset (bell) | `_components/notifications-bell.tsx:81` | Unread badge position | **CHANGED (G3)** | Confirmed physical-right; `→ -end-1`. The ONE RTL leak in the tree. |
| `.progress` ARIA progressbar | `globals.css:356` + call-sites (no `role=progressbar`) | SR percentage | **CHANGED (G4)** | Plan's `ThresholdProgress` adds `role=progressbar`+`aria-valuetext`. Good. |
| `--text-muted` ~4.76:1 on tinted bg | `globals.css:70` | Secondary text contrast | **CHANGED (G5)** | Use `--ink-600` on tinted rows. Computed, not rendered (08 §9 — verify in real Chrome). |
| `--text-soft` ~2.7:1 decorative-only | `globals.css:71,326,468` | Placeholder/em-dash only | **AS-IS-OK** | RULE A1 — must never carry meaning in redesign. |
| Focus ring `ring-2` minimum | `components/ui/button.tsx` (per 08 §1.1) | 1.4.11 non-text contrast | **COVERED** | RULE A3 — don't reduce to ring-1 in re-skin. |
| `--row-h: 44px` target size | `globals.css:105` | 2.5.5/2.5.8 target size | **COVERED** | RULE A6 — AAA default; compact 36px opt-in only. |
| RTL logical-property cleanliness (~99%) | whole tree (1 physical hit = the bell) | ms/me, start/end discipline | **COVERED** | 08 §3.1 — redesign must keep it. |
| Directional-icon mirroring | `owner-detail.client.tsx:128`, `projects/new/page.tsx:1445,1457` | Back/next arrows in RTL | **AS-IS w/ [UNVERIFIED]** | The bare `<ArrowLeft>` at new/page:1457 needs a live-Chrome RTL check (08 R3 / completeness §1). |
| LTR numeric islands (`dir=ltr .tabular`) | precedents `step-up:246`, `tenant/login:364`, `globals.css:470` | "12 / 18" must not reorder | **COVERED** | 08 R4 — ThresholdProgress counts must sit in `dir=ltr`. |
| Disabled = opacity-50 only | `button.tsx` (per 08 §10.2) | Low-vision distinguishability | **AS-IS-OK** | WCAG exempts disabled; keep label visible (advisory). |

## 4. Perf (RSC-prefetch baseline + LCP budget)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| RSC prefetch Pattern A | `lib/query/prefetch.ts`; 10 `*.server.ts` | Kill post-hydration waterfall | **COVERED** | 07 §1.2 — extend, never reinvent. |
| ManagerHome ad-hoc fetch (Pattern B) | `manager-home.tsx:31–45` (raw fetch, no Zod, `NEXT_INTERNAL_API_URL`) | Home stats, no cache/invalidation | **CHANGED (E2.1)** | Converge onto Pattern A (locked D.3). Real liability. |
| `'use client'` islands kept (accepted debt) | per web CLAUDE.md §v9-M-1 | Uniformity over SC body render | **AS-IS-OK** | 07 §1.4/§7 — do NOT convert in E2. But keeps home a client waterfall (feeds X7). |
| Query retry 3 / mutation 0 / refetchOnFocus | per web CLAUDE.md; `query-provider.tsx` | Connectivity-aware retry; idempotent mutations | **COVERED/AS-IS** | Completeness §6 correction — already good; gap is offline UX (C4). |
| Heebo @ 3 weights for LCP (PR #47) | `globals.css` Heebo; master §3.2 (400/500/700 only) | LCP budget | **COVERED (constraint)** | Plan forbids adding weights. Good. |
| Warm-200ms LCP budget vs M3 count-up | M3 (master §5 Wave 3) | Animate hero number every home load | **GAP (X7 / G-MOTION-PERF)** | Risk named (master §7) but no measured LCP gate owns it. |
| memoised `select` keyed on locale | `hooks/use-projects.ts` (§PERF-H3) | Avoid adapter re-run | **AS-IS-OK** | Redesign hooks should follow. |
| Key-parity (server===client query key) | `*.keys.ts` plain modules | Silent cache-miss avoidance | **COVERED** | 07 §7 — every new prefetch needs a key-parity spec. |

## 5. Error / empty / loading (DataState contract)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| `ListPageShell` (real DataState precedent) | `components/ui/list-page-shell.tsx:94–157` | loading skeleton / retryable error / **403 terminal no-retry** / empty | **COVERED → generalize (C2)** | This — NOT a special "import taxonomy" — is the strongest existing 4-state contract. Plan under-credits it; the new `<DataState>` should extract from here. |
| `isPermissionDenied` (403 branch) | `list-page-shell.tsx:18–30,123` | 403 `forbidden` → muted, no retry | **COVERED** | C2 P-ERR-3 "403 vs 5xx code-enforced" already shipped here. |
| Import page granular taxonomy | `imports/[id]/page.tsx:37,79,93` (notFound/loadFailed/not_cancellable/confirmFailed) | Per-action error copy | **COVERED (model)** | Plan cites it as THE model (C2/P-ERR-1). It IS good, but page-local (not a reusable component) — `ListPageShell` is the reusable one. |
| `SignatureProgressBoard` returns bare `null` on error | `signature-progress-board.tsx:36` (per master §5) | Silent void = "blank means broken" | **CHANGED (C2)** | Kill silent-null; route through `<DataState>`. Correctly planned. |
| `error.tsx` / `not-found.tsx` boundaries | `app/global-error.tsx`, `app/not-found.tsx`, `app/[locale]/error.tsx`, `app/[locale]/not-found.tsx` | Catch THROWN render errors only | **AS-IS-OK** | Confirmed 4 exist (completeness §7 correction). They do NOT catch null-returns → C2 still needed. |
| Zero per-route `(dashboard)/**/loading.tsx`/`error.tsx` | — (verified absent) | Consistent per-route states | **CHANGED (C2)** | Each island rolls its own → inconsistent. `<DataState>` unifies. |
| Empty-org / first-run distinct state | — (absent) | Day-one empty vs empty-because-done | **GAP (C3)** | The "הכול רגוע" reward is dishonest on a brand-new org. P0-class; correctly surfaced. |
| `ListSkeleton` (token-correct, `aria-busy`) | `components/ui/list-skeleton.tsx` | Loading shimmer | **COVERED (w/ bug)** | Uses dead `bg-card` (master §3.3 #1) — fix in E2.0. |
| Offline banner / `navigator.onLine` / paused mutations | — (verified absent) | "אין חיבור" + queued send | **GAP (C4)** | Mutations `retry:0` → flaky field connection silently drops the chase send. P1. Optimistic flip must distinguish sent vs dropped-offline. |

## 6. Security / PII

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Global `APP_PIPE` (P0.1) | SECURITY-POSTURE §3 P0.1 | Validation by construction, not convention | **GAP (X3)** | Not in any v2 doc. E2's new endpoints (B1/B2/B4/S4) should land after/with this. |
| `input-validation-coverage` CI guard (P0.2) | SECURITY-POSTURE §3 P0.2 | Static guard every `@Body/@Query` is pipe-bound | **GAP (X3)** | Same. Model exists (`api-docs-coverage.spec.ts`). |
| Magic-byte verify on documents (P0.4, in-flight) | SECURITY-POSTURE §3 P0.4 | Type-confusion defense-in-depth | **GAP (track)** | In flight on `fix/document-magic-byte-verification`; redesign touches doc upload UX (C9) — must not regress. |
| `.strict()` on `List*Query` (P1.1) | SECURITY-POSTURE §3 P1.1 | Reject unknown query keys | **GAP (X3)** | S4 search + B1 pulse add new `*Query` schemas — should be `.strict()` from day one. |
| No PII in URL — POST-body search | per web CLAUDE.md; `lib/api/owners.ts` (POST search) | national_id never a query param | **COVERED** | S4 omnibox extends `POST /owners/search`, `view_owner_pii`-gated (master §2.4). Correct. |
| `view_owner_pii` gating + masking | `components/owners/owner-pii-reveal.tsx`; `members.ts` | Reveal-on-demand PII | **COVERED** | B4 holdout-name read inherits this gate. |
| PII-in-motion: omnibox dropdown | S4 (new surface) | Ephemeral results, no history, bidi-strip labels | **CHANGED (C9/P-PII-1)** | Planned (master §S4 guardrail). Bidi-strip on `aria-label` ties to G2 (no static guard). |
| PII-in-motion: xlsx export / signed-doc / committee packet | `export-xlsx-button.tsx`; C1 print | "contains personal data" cue | **GAP (C9/P-PII-2)** | Bulk PII egress the redesign elevates; no cue today. |
| pino redaction / `/sign/<jwt>` censor | SECURITY-POSTURE §2 Logging | PII never logged | **AS-IS-OK** | BE posture; redesign must not add PII to client logs/console. |
| RLS FORCE + withTenant/withProvider | SECURITY-POSTURE §2 A01 | Tenant isolation backstop | **AS-IS-OK** | New BE slices MUST go through `withTenant`/`withProvider` (CLAUDE.md hard rule). |
| `app-no-new-inline-colors` ratchet (hex-only, blind to class leaks) | `app-no-new-inline-colors.spec.ts` | Token-only color enforcement | **CHANGED (E2.0)** | Add default-palette class-name guard (master §3.5); re-measure baseline incl. 3 unopened surfaces. |
| `app-forms-no-get-fallback` (no GET cred leak) | `app-forms-no-get-fallback.spec.ts` | `<form method=post>` | **COVERED** | Universal gate; every redesigned form inherits. StepUp + access-reason already comply. |

## 7. Token bugs the plan names (cross-cutting, confirmed in real CSS)

| Item | file:line | Plan status | Note |
|---|---|---|---|
| `bg-card` dead class (`card` undefined in tailwind colors) | `globals.css` uses; `tailwind.config.ts:82` colors has no `card:` | **CHANGED (E2.0)** | Confirmed: 40 files use `bg-card`; `card` not a color. Incl. `step-up-unlock.tsx:209`, `list-skeleton.tsx`. |
| `--r-lg` self-contradiction | `globals.css:102` (`12px`) vs `tailwind.config.ts:139` (`lg→var(--radius)`=0.5rem/8px) | **CHANGED (E2.0)** | Confirmed both values. `.card` vs `rounded-lg` render different corners. |
| Missing `--space-*` / `--text-*` scales | `globals.css` (only `--pad`/`--row-h`; no `--space-N`, no `--text-display/title`) | **CHANGED (E2.0)** | Confirmed absent. Blocks "generous whitespace" being dial-able. |
| No `prefers-reduced-motion` / motion tokens | `globals.css` (no `@media reduce`, no `--motion-*`, no `@keyframes`) | **CHANGED (M1)** | Confirmed absent. M1 adds them. |

---

## Inventory totals
~58 cross-cutting items inventoried across 7 groups. **COVERED/AS-IS-OK: ~33.
CHANGED (plan modifies, mostly correctly): ~16. GAP (plan misses / under-addresses): ~12**
(X1–X9 plus C3 empty-org, C4 offline, C9 PII-egress cue, G2 bidi-guard, dual-plural).
The CHANGED items are largely sound; the danger to the one-shot goal is concentrated in the
GAPs — above all the three factual-grounding errors (X1/X2 the non-existent ConfirmDialog +
17 live native confirms) and X3 (security P0 program unreconciled with the new BE slices).
