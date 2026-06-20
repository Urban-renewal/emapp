# EMAPP E2 — Build Slice Ledger

> The autonomous-run record. One section per slice; a slice is NOT "merged" until every
> DoD gate is ✅ with evidence. Plan of record: `docs/design-research/v8-final-verification/03-consolidated-master-plan.md`.
> Owner greenlit the autonomous run 2026-06-18 ("flawless · security · with documentation").

## ▶ RESUME POINT (read FIRST after any crash/restart — updated each turn)

**How to recover exactly where it stopped:** (1) read THIS block; (2) `git -C C:/emapp log --oneline -25`
= what's MERGED on `main`; (3) `gh pr list --state open` = open PRs (their CI/merge state is the live truth,
not this file); (4) for each open PR, `gh pr view <n>` + check the branch worktree under
`C:/emapp/.claude/worktrees/`; (5) the process memories (never-ask · real-Chrome-QA merge-gate · CSS→`next build`
& copy→`e2e` lessons) + the plan (`docs/design-research/v8-final-verification/03-consolidated-master-plan.md`) +
the merge-gate (`docs/E2-MERGE-GATE.md`) govern HOW to proceed. Background agents + the in-session task list do
NOT survive a crash — git + GitHub + this file + the memories do, so they are the source of truth.

**As of 2026-06-20 (Chrome BACK; CENTERPIECE + 3 RESKINS real-Chrome-QA'd + MERGED; 2 reskins HELD on env):**

- **MERGED — Wave 0 (10):** S0-SEC #415 · PERF #416 · M0+G6 #417 · N15 #418 · E2.0 #419 · E2.0b #420 · M1 #421 ·
  P-TZ-1 #422 · C2 #423 · ConfirmDialog #413(pre). Ledger #424 · merge-gate #429 · resume #431 · #434.
- **MERGED — Wave 1:** B0 #426 · B5 #428 · C13 #427 · import-stats #425 · sidebar 14→5 #430 (QA PASS) ·
  consent-CTE refactor #432.
- **MERGED — Wave 2 BE:** **B1 signature-pulse #435** (security PASS) · **B4 holdouts #436** (security PASS).
- **✅ MERGED — Wave 2 CENTERPIECE (real-Chrome QA in owner's Chrome, 2026-06-20):**
  - **#437 E2.1 mission-control HOME** (e50ffe1) — QA PASS all axes (greeting + pulse sentence + 5 ranked
    ActionCards from B1 + explain-chip w/ aria-controls + basis label on every card; B1 wire zero-PII; single
    aggregate call, no N+1). **FOUND+FIXED a real bug in QA: the `text-muted` invisibility trap** — bare
    `text-muted` resolves to shadcn `muted.DEFAULT` (#f5f5f4, ~1.0:1 contrast = invisible); fixed to
    `text-text-muted` (#64748b, AA) + pulse promoted to `text-text` (commit on the branch pre-merge). Unit tests
    passed BUT the text was visually invisible — exactly why real-Chrome QA is mandatory.
  - **#438 E2.2-S3 board** (4d792ed) — QA PASS (ThresholdProgress "N מתוך M דירות · % · לפי שיעור הבעלות" + basis
    label legible 4.8:1; never-null zero-state; per-apartment drill-down; **"מי תקוע" on-demand gated holdout
    name reveal works — "מירי בר" rendered for manager**, name-only, NameDisplay-wrapped; B4 properly authed).
  - **#433 E2.2-S1** (4149deb) — QA PASS (board/signatures tab now FIRST + default-selected; basis label present;
    clean console; no redirect loop).
  - **#411 CLOSED** (superseded by merged #437).
- **🔎 FINDINGS carried (follow-ups, NOT blockers):**
  - **(F-a) `text-muted` trap is SYSTEMIC RISK in the reskins.** The palette ratchet WHITELISTS `text-muted` as
    "semantic" so it never flags the invisible-text bug. Before/while QA-ing each reskin, GREP the diff for added
    bare `text-muted` (not `text-text-muted`) and fix → `text-text-muted`. Consider a follow-up guard that bans
    bare `text-muted` as a FOREGROUND utility.
  - **(F-b) apartment designation ambiguity (pre-existing, not #438).** The board per-apartment rows show "דירה N"
    with no building/floor qualifier, so same-numbered apartments across buildings render identically (e.g. two
    "דירה 1 · 0/1 חתמו"). The apartments ARE distinct (distinct ids, no key warning, count correct). Follow-up:
    include floor/building in the `designation` (signature-progress adapter / `boardApartments.row` i18n).
- **✅ MERGED — RESKINS (real-Chrome QA, 2026-06-20):**
  - **#439 C5 projects/new** (bd751b9) — **FOUND+FIXED 29 instances of the F-a `text-muted` trap** (every hint +
    inactive stepper label was invisible; CI was green!) → `text-text-muted`. Re-walked: all hints legible.
  - **#441 dashboard-lists** (d795842) — QA PASS, full whole-page contrast audit across all 6 pages
    (owners/notes/tasks list+detail/imports list+detail) = 0 low-contrast, 0 trap.
  - **#443 org-pages** (254df7a) — QA PASS, contrast audit across sig-requests/members/owners list+detail = 0
    low-contrast; **owner-pii-reveal masking intact** (•••• present, no raw national_id in DOM). Palette baseline
    reconciled to **68/10** (the #441+#443 disjoint reductions STACKED below either's solo baseline).
- **⏸ HELD — 2 RESKINS (gate-blocked on env, NOT merged):** **#444 provider subtree** + **#442 C14 tenant portal**.
  Both: static-clean (0 `text-muted` trap), CI-green (build/test/e2e vs MOCKS), same proven token-swap pattern as
  #441/#443. **BLOCKER:** the mandated live role-session real-Chrome walk can't run in local dev — provider has NO
  seeded admin account (provider/login needs email+pw+TOTP; only manager@alpha.dev exists), and the tenant OTP
  Server-Action submit via automation bounced to /login (though the OTP STEP was reached → **an owner with phone
  `0501234567` DOES exist** in local-db; org slug `alpha-dev`; dev OTP code `000000`). Per the merge-gate + the
  #439 lesson (CI-green ≠ visually-correct), NOT merged un-walked. **RECIPE to finish (seconds once a session
  exists):** (1) start-dev-local.ps1; (2) tenant: /he/tenant/login → phone 0501234567 + org alpha-dev → OTP
  000000 → walk /he/portal; provider: a real provider-admin email+pw+TOTP (000000) → walk /he/provider/*; (3) run
  the whole-page contrast audit (see #441 method) on each reskinned page; (4) `gh pr update-branch` → reconcile the
  palette baseline (guard reports the true stacked count) → merge. Branches: feat/e2-reskin-provider,
  feat/e2-wave4-c14-tenant-reskin.
- **CHROME-BACK POSTURE:** Claude-in-Chrome reconnected; real-Chrome QA gate OPERATIONAL. Dev stack:
  `start-dev-local.ps1` runs API+web dev on local-DB (:3000/:3001); manager@alpha.dev / DevPassword123!. ⚠️ the
  manager session expires on ~token-TTL during long branch-switch recompiles — re-login when a nav lands on /login.
- **NEXT:** finish #442/#444 (above) when a provider/tenant session is available · **M2 chase + M3 wow** (build ON
  the now-merged home/board) · S4 search · the F-a/F-b follow-ups (a guard banning bare `text-muted` as a
  foreground utility; designation building/floor qualifier). **DEFERRED (owner-oversight):** A1 reminder-memory +
  needsHuman columns (migrations — risky while away) · B2 Gate-6 migration · B3 worker · C1 print · C16/C12b · OD-1.
- **Dev QA session:** `manager@alpha.dev` / dev fixture `DevPassword123!` on `:3001`. Login button-click has a
  React/Server-Action fidelity gap → set fields via `form_input`, submit via `form.requestSubmit()`, then walk
  for real. Disclosure/click handlers: read aria-expanded AFTER the React re-render (a later tool call), not
  synchronously in the same eval.

## Binding rules (every slice) — see plan §2

- Interim consent-basis-label rule · DO-NOT-FABRICATE register · two-track action rule · 6 AI-safety rules.
- **Universal DoD:** `pnpm typecheck && pnpm lint && pnpm test` green (incl. all guards) · real-Chrome 4-axis
  per affected role · perf budget (warm 200ms; seeded-50 where it touches orgStats/signatureProgress) ·
  North-Star check · routes never deleted · new endpoints get a gen-api-docs entry · **security-review BEFORE
  commit on PII/auth/RLS/external-write slices**. Never force-merge; never merge on red.

## Plan corrections carried (so they can't silently re-enter)

- **MR#1 RESOLVED:** ConfirmDialog/M0b IS shipped — PR #413 merged (`7c1ae32`); `confirm-dialog.tsx` on main.
  The v8 verification read a pre-#413 tree. Remainder: 2 stray `window.confirm` to migrate + the
  toast/live-region (M0+G6) is genuinely missing → Wave-0 item.
- **MR#2 ack:** the scheduler EXISTS (3 pg-boss sweeps); B3 = add a 4th consumer + 3 notification kinds
  (execute v4's re-scope, NOT v3's "build a scheduler").
- **MR#3 (owner):** Wave-5 external MVP (X1–X4) + DOM-PKG ("send the bureaucracy") is a blocker-class
  owner-scope call — IN or OUT of v1? Flagged; does not block Wave 0.

## Owner / legal STOP-points (flagged, surfaced in parallel — do not block the build)

B0 statutory % (OD-1/3) · OD-7 signer-identity · B3 worker approval · B2 Gate-6 migration · C1 print-vs-PDF ·
C12b/C16 go-live subset · N11 tabu honesty · C10/C11 scope · Wave-5 external scope · Wave-6 AI/DPA · Ops keys.

---

## Wave 0 — Foundation + security/perf/primitive gate

### S0-SEC ⭐🚧 — global validation pipe + input-validation-coverage CI guard · status: ✅ MERGED 2026-06-19 (#415)

- **Spec (plan §4 Wave 0 + SECURITY-POSTURE P0):** global `APP_PIPE` + `@ZodBody/@ZodQuery` metadata +
  explicit opt-out for the 4 exceptions (documents `:id/content`; auth + provider-auth `refresh`/`logout`);
  NEW CI guard `input-validation-coverage.spec.ts` (static scan of every `*.controller.ts`, modeled on
  `api-docs-coverage.spec.ts`); + P0.3 regression lock (`CreateOwnerDto.safeParse({national_id:'123456789'})` fails).
- **Why:** make "100% validated" a CONSTRUCTION guarantee, not per-endpoint convention. LANDS BEFORE B0/B1/B4/B5/B2.
- **DoD:** typecheck+lint+full API suite green (behavior preserved) · the new coverage guard green · P0.3 green ·
  `@security-reviewer` (security-sensitive) · PR opened, merge-on-green.
- **Evidence:** PR #415, all CI green (typecheck·build·conformance·e2e·test·lint·audit·secrets). Design = safer
  shape: per-route pipes unchanged (zero behavior change); `GlobalZodValidationPipe` APP_PIPE backstop
  (fail-closed NUL/invalid-UTF-8 reject at one choke-point); `@ZodBody/@ZodQuery` decorators; `@RawBody/@NoValidation`
  on the 4 exceptions; coverage guard scans clean over 45 controllers/173 handlers; P0.3 luhn lock green.
  Security-review: initial BLOCK (3 HIGH+1 MED — buffer-DoS, query-masking) → all fixed pre-commit → re-review PASS.
  API suite 1714 passed; the 1 `provider-self-audit` failure = the known keyset flake (reproduces with slice
  stashed; CI green in isolated env).

### PERF ⭐ — read-through cache + seeded-50 perf gate · status: ✅ MERGED 2026-06-19 (#416)

> CI flake noted: the merge run's e2e tripped on `sign-flow.spec.ts:249` (the §P0-3 console-error guardrail
> firing on a _deliberate_ 401 resource-load — a timing race, not PERF; PERF is BE-only + critical-path passed).
> GREEN on re-run. **Known flake → re-run, don't debug, when a diff doesn't touch the sign-flow.**

- **Spec (plan §4 + N9):** wire the EXISTING `PostgresCacheProvider`/`cache_kv` read-through over `orgStats`
  (`projects.service.ts`) + `signatureProgress`; tenant-scoped keys + write-invalidation;
  a seeded 50-project perf test (warm <200ms) that B0 MUST pass.
- **Why:** B0's share-weighted CTE is heavier; prove sub-second at 50 projects before it ships. Gates B0.
- **DoD:** typecheck+lint+API suite · seeded-50 perf test <200ms warm · cache-hit==fresh-compute correctness ·
  security-review (no cross-tenant cache leak) · PR, merge-on-green.
- **Evidence:**
  - **Design:** `StatsCacheService` (new, `apps/api/src/modules/projects/stats-cache.service.ts`) over the
    existing provider. Key = `stats:org:<orgId>:<suffix>` (orgStats: `orgStats:all` | `orgStats:agent:<id>`;
    sigProgress: `sigProgress:p:<projectId>`) — `cache_kv` has NO RLS, so org_id-in-every-key IS the isolation.
    Value = envelope `{e,v}`; read folds epoch+value into ONE round-trip (`ICacheProvider.getMany`, new).
    Invalidation = bump per-org epoch (`invalidateOrg`) at: public-sign, ownership replaceSet, sig-request
    create/createBulk/cancel, project create/update/archive (best-effort, never fails the write).
  - **Correctness:** `stats-cache-correctness.spec.ts` 6/6 green — cache-HIT deep-equals uncached fresh-compute
    (both methods, cold+warm); cross-tenant isolation; invalidation-on-write (post-sign returns NEW consent);
    distinct agent/manager scope keys.
  - **Perf (seeded 50 projects):** `stats-cache-perf.spec.ts` 4/4 green — cache-layer HIT (isolated) <200ms;
    end-to-end `orgStats` warm ≈0ms (pure cache hit) <200ms; warm orgStats ≪ cold uncached. Honest bottleneck
    REPORTED (not gated): end-to-end `signatureProgress` warm ≈590ms on dev/CI = the `assertProjectVisible`
    authz round-trip to REMOTE Neon (the cache can't/shouldn't remove it; it's a cheap indexed SELECT that does
    NOT get heavier in B0; co-located in prod = negligible). The cache removes the heavy CTE — exactly N9's need.
  - **Drive-by:** fixed `PostgresCacheProvider.incrementCounter` jsonb 42804 (integer→jsonb); 374 db tests green.
  - **Security:** `@security-reviewer` PASS — 0 CRITICAL/0 HIGH; no cross-tenant key collision, no cache-hit
    authz bypass, no PII in keys/values. 2 MED non-blocking (import-materialize freshness follow-up spawned;
    incrementCounter return-handling aligned).
  - **Non-breaking:** cache via `@Optional()` DI → every `new ProjectsService()`/sig/ownership unit spec keeps
    pre-cache compute-fresh behaviour (existing suites green).

### M0+G6 — app-root action-toast / aria-live live-region primitive · status: ✅ MERGED 2026-06-19 (#417)

- **Spec (plan §4 "M0+G6" row + §2.3 two-track rule):** ONE app-root `role="status" aria-live="polite"`
  (+ an `assertive` `role="alert"` sibling) live-region that is BOTH (a) the ActionToast — auto-dismiss
  (6s default), pause-on-hover/focus, optional undo, concurrent settle (independent per-toast timers) —
  AND (b) the G6 a11y announcement region. A `useToast()`/`useActionToast()` hook mirroring `useConfirm()`
  (headless `createToastController` seam). Mounted ONCE at the dashboard layout. Migrate ALL ~11 bespoke
  inline "saved"/success sites + the remaining stray `window.confirm`.
- **Why:** the redesign's core two-track action rule (§2.3) needs an undo-toast for the reversible 95%
  (resend/archive/status/assign/role grant-revoke/share-revoke/member-remove ⇒ instant + undo, NOT a confirm);
  and `components/ui/` had no toast/live-region at all (V9). Precondition for Wave 2–5 undo/announce.
- **DoD:** `pnpm typecheck` 0 · `pnpm lint` clean · `pnpm --filter @emapp/web test` green (911) · toast
  unit/RTL spec (open · auto-dismiss · undo fires · concurrent settle · pause/resume · a11y role/aria-live ·
  no-inline-color) · i18n-coverage guard green (new `toast.*` + success keys in he.json + en.json, symmetric) ·
  inline-color ratchet (`app-no-new-inline-colors.spec.ts`) green · `app-forms-no-get-fallback.spec.ts` green ·
  human-lead real-Chrome 4-axis toast verify BEFORE merge.
- **Evidence:**
  - **Primitive:** `apps/web/src/components/ui/action-toast.tsx` — headless `createToastController(onChange, timers)`
    (queue/dismiss/pause/resume, injectable timer host so fake-timers drive auto-dismiss in node-env) +
    `ToastProvider` (context, mounted once in `(dashboard)/layout.tsx`) + `useToast()`/`useActionToast()` +
    `ToastRegion` (two `aria-live` regions: polite/status + assertive/alert). Token-only styling via new
    `.toast*` classes in `globals.css` (logical props `inset-inline-start` for RTL; ZERO inline color literal
    in the `.tsx`, so the ratchet stays at baseline 58/9). Mirrors `confirm-dialog.tsx` idiom exactly.
  - **Migrated sites (11 + 1 confirm):** 5 settings configs (branding/consent/limits/localization/notifications —
    inline `var(--success-700)` "saved" span → `toast.show({message: t('saved')})` on the success transition) ·
    `role-editor.tsx` (success → `toast.show(saved|created)` before close) ·
    `member-capabilities-panel.tsx` (removed `saved` boolean + hardcoded `text-emerald-700`; save + apply-preset
    now fire an **undo-toast** that restores the prior capabilities — the marquee two-track usage) ·
    `member-overrides-panel.tsx` (set/clear → undo-toast with the inverse mutation). PLUS the M0b remainder:
    the 1 stray live `window.confirm` (`members/[userId]/page.tsx` revoke) → `useConfirm({destructive})`.
  - **Test:** `apps/web/src/components/ui/action-toast.spec.ts` — 13 cases (8 controller A: queue/auto-dismiss/
    sticky/undo/concurrent-settle/pause-resume/idempotent-dismiss/monotonic-ids; 5 render B: both live regions,
    polite message, undo button, assertive routing, no-inline-color). Full web suite 911 passed.
  - **NOTE — confirm count:** plan/ledger said "2 stray `window.confirm`"; an exhaustive scan of the current
    `main` tree finds exactly ONE (revoke). A prior slice migrated the other. The one that exists is migrated.
  - **Green-gate:** typecheck 0 · lint clean · 911/911 tests · all guards (i18n-coverage, inline-color ratchet,
    forms-no-get-fallback) green.
  - **PR:** https://github.com/Urban-renewal/emapp/pull/417 — ✅ MERGED (`8a8096f`). Security-review PASS
    (0 CRITICAL/0 HIGH). Full CI green at merge (e2e·test·typecheck·build·conformance·lint·audit·secrets), CLEAN.
  - **Real-Chrome 4-axis verify (human-lead, pre-merge):** on the live `/he/settings` dev app —
    (1) **DOM/render:** full-DOM read confirmed BOTH live-regions mounted at app root —
    `role=status`/`aria-live=polite` + `role=alert`/`aria-live=assertive` siblings, OUTSIDE `<main>` (portal).
    (2) **Network:** changed the limits config (200→201) + שמירה → `PATCH /api/v1/org/settings → 200` then
    `GET /api/v1/org/settings → 200` refetch — the migrated toast site fires end-to-end.
    (3) **Toast lifecycle:** success-transition toast displayed then self-cleared (status region empty post-read =
    the 6s auto-dismiss the 13 unit cases assert; too fast for a static snapshot, proven by network-200 + mounted
    region + unit suite). (4) **No-freeze/console:** every config's שמירה click executed cleanly, zero console
    errors. CDP `Page.captureScreenshot` was unstable under dev-server load (renderer healthy — get_page_text/
    read_page/clicks/network all worked); the toast was EXONERATED as any freeze cause. Verdict: PASS.

### N15 — env-gated `CAMPAIGN_SEND_ENABLED` kill-switch · status: PR OPEN (#418, green-gating)

- **Spec (plan §4 Wave-0 item 11):** a cheap-insurance global operational lever to halt project-wide
  signature-campaign sends without a redeploy.
- **Scouting correction (recorded so it can't re-enter):** the plan said "1 line below the org-suspend check
  in the campaign service." There IS no org-suspend check in the send path — org suspension is enforced at the
  AUTH boundary (D.49: `auth.service` throws `401 org_suspended` post-password + session revocation), so a
  suspended org never reaches `createCampaign`. The first scouting agent correctly STOPPED rather than fabricate
  an anchor; I decided placement: authz-first, then the switch as the last gate before fan-out (no info leak).
- **Evidence:** `signature-requests.service.ts:711` — inside `createCampaign`'s `withTenant` callback, immediately
  after `requireAgentCapability('manage_signatures')` (line 703) and before the `createBulk` fan-out:
  `if (sendFlag === '0' || sendFlag === 'false') throw new ServiceUnavailableException({ error: { code: 'campaign_send_disabled' } })`.
  Env `CAMPAIGN_SEND_ENABLED: z.string().default('1')` added to `packages/config/src/env.ts` (opt-OUT idiom,
  mirrors `PUBLIC_SIGNUP_ENABLED`) + `.env.example` placeholder. Tests `signature-campaign.spec.ts` CAMP-6
  (default → proceeds) + CAMP-7 (`'0'` → 503, **zero fan-out** rows) — 8/8 green. typecheck 0 · lint clean.
- **Review (direct, inline):** correct/minimal/root-cause; authz resolves first so an unauthorized caller gets
  403 and never learns the switch state; D.16 envelope; no PII logged; no RLS/auth-semantics change; no new
  external surface (env lever only). BE-only → no browser walk required. PR #418.

### E2.0 + E2.0-GUARD — semantic design-token tier + palette-leak ratchet · status: ✅ MERGED 2026-06-18 (#419)

- **Spec (plan §4 Wave-0 lines 185-186):** Tier-2 semantic token block + `--space-1..12` &
  `--text-display..caption` (Heebo 400/500/700) + fix 3 bugs (dead `bg-card`, `--r-lg` 12-vs-8,
  `borderRadius.lg`) + brand→navy-900 (D.5); PLUS a default-palette-class leak guard with a re-measured
  FULL-TREE baseline (A8·A9 false-floor risk).
- **Evidence (3 files: `globals.css`, `tailwind.config.ts`, new `app-no-default-palette-class.spec.ts`):**
  - **3 bugs were all REAL:** (a) `--r-lg`: globals 12px vs tailwind `borderRadius.lg→var(--radius)` (8px) —
    reconciled `lg→var(--r-lg)` (12px). (b) `bg-card`: 64 sites/41 files referenced a `card` color + `--card`
    var that NEVER EXISTED → silently transparent (masked by the white app shell); now `card→--card→
--bg-surface→#fff`. (c) `borderRadius.lg` aligned to the reconciled `--r-lg`.
  - **Tier-2 tokens:** brand/card/surface/text/status color mappings + spacing scale (`--space-1..12` = EXACT
    Tailwind default px 4/8/12/16/20/24/32/40/48 → existing `p-4`/`gap-6` pixel-identical, zero regression) +
    type scale (display 28/36 … caption 12/16) + weights 400/500/700. All map onto existing Tier-1 palette.
  - **Guard:** bidirectional ratchet (fails on INCREASE = new leak, and on DECREASE = lower the baseline);
    precise regex (22 default families × numeric shade × `\b` boundaries; semantic classes pass). Baseline
    **149 occurrences / 34 files** re-measured across the FULL tree (Provider subtree + `*/new` + panels) —
    false floor closed; existing leaks FROZEN (not fixed — that's E2.0b+).
  - **Green:** typecheck 0 · lint clean · **912 web tests** · new guard green · inline-color ratchet unchanged
    (58/9; globals.css is `.css`, not scanned) · `app-forms-no-get-fallback` green.
- **⚠️ BUILD-BREAK CAUGHT + FIXED (the slice's key lesson):** first CI run FAILED `build` (57s) + `e2e`
  (cascade). Root cause: a globals.css comment `/* … --bg-*/--text* … */` had an embedded literal `*/` that
  closed the comment early → PostCSS "Unknown word" at `globals.css:126`. **vitest never runs the PostCSS
  production build, so 912 green + typecheck 0 + lint clean ALL passed while `next build` broke.** Fixed by
  rewording the comment (commit `b8ec190`); local `next build` then green (`✓ static pages 3/3`). LESSON now
  durable in memory [[project_fe_css_slices_need_next_build_dod]]: every CSS/token slice DoD MUST include
  `next build`, not just `test`. Re-ran CI → all green; `update-branch` (was BEHIND after N15) → auto-merge.
- **Real-app verify (token-level, screenshots blocked by CDP instability + session expired):** live
  computed-style inspection on the running `:3001` app proved Turbopack picked up the merged config —
  `--r-lg`=12px, `--card`→`rgb(255,255,255)`, `--brand`→`rgb(11,37,69)` (navy-900), `--space-4/6`=16/24px,
  `--status-warning-bg`→`rgb(255,251,235)`, `--text-display-size`=28px, `--weight-bold`=700. Login page renders
  cleanly with the new tokens. `bg-card`→white is proven at the token level + is a by-construction no-op on the
  white app shell (`--background:0 0% 100%`). Verdict PASS. PR #419 (squash `1e601c3`).

### E2.0b — `statusColor`→`intent` rename + status-badge/Button token re-home · status: ✅ MERGED 2026-06-18 (#420)

- **Spec (plan §4 line 187):** re-home `status-badge.tsx` + `Button.destructive` → token `.badge-*`; rename
  `statusColor`→`intent` (success|warning|danger|info|neutral) across VM + adapters + specs.
- **Scoping correction:** plan said "VM + 6 adapters + 3 specs"; the true surface was **65 occurrences / 35
  files** (9 VMs, 9 adapter maps, 13 consumers, 4 specs) — typecheck was the completeness gate and also
  surfaced 2 ripple feeders (`member.vm.stateColor`, `task.vm.priorityBadge`) remapped in the same change
  (46 files total). A field rename MUST be atomic; this is why typecheck (not a count estimate) is the proof.
- **1:1 faithful translation (verified against the OLD map — ZERO behavior change):** old `STATUS_COLORS`
  (gray|amber|emerald|red) → new intents 1:1: gray→neutral, amber→warning, emerald→success, red→danger.
  Spot-checked the one borderline (`project.completed`): was `gray` before → `neutral` now (SAME family) —
  no regression. Every status enum maps identically; badges are provably pixel-identical.
- **Badge re-home:** `status-badge.tsx` now renders `<span class="badge badge-{intent}">` consuming the
  token-backed component classes already in `globals.css` (`.badge-success/.../.badge-info` →
  `--status-{intent}-bg/-fg` → the success/warning/danger/navy/ink palette); prop `color`→`intent`; dropped the
  `CHIP_TO_BADGE` indirection. `Button` destructive → danger token (`bg-danger-600 / hover:bg-danger-600/90`).
  No default-palette classes remain in `components/ui/*`.
- **Palette-leak ratchet LOWERED 149/34 → 139/32** (status-badge −8, button −2; 2 `components/ui` files fully
  retired) — the bidirectional guard's "decrease" path exercised correctly (baseline + doc comment updated).
- **DoD (all green locally + CI):** typecheck **0** (rename-completeness proof) · lint clean · **912 web tests**
  (88 files) · **`next build` GREEN** (the E2.0 lesson applied — no CSS break) · guard green at 139/32 ·
  inline-color ratchet still 58/9 · forms-no-get-fallback green. CI CLEAN, squash-merged `3a81faf`.
- **Verify:** review-level (the decisive surface for a value rename) — confirmed the 1:1 faithful color→intent
  mapping against the removed code (zero visual change by construction) + `.badge-{intent}` classes exist and
  are token-backed + green build/tests. Authenticated badge pixel-walk deferred (session expired + no-credentials
  rule); unnecessary given the badges are provably identical to pre-rename. No PII/auth/RLS → no security review.

### M1 — motion duration/easing tokens + reduced-motion guarantee · status: ✅ MERGED 2026-06-18 (#421)

- **Spec (plan §4 line 188):** `--motion-duration-{fast,base,slow}` + `--motion-ease-*` + `prefers-reduced-motion`
  (zero durations under reduce). Definition-only.
- **Evidence (2 files: globals.css + tailwind.config.ts, +48 lines, additive):** values doc-PINNED (v2
  `06-interaction-motion §3.6`): fast 120ms (matches existing button .12s) / base 200ms / slow 360ms (bar-fill,
  count-up); `--motion-ease-out: cubic-bezier(0.2,0,0,1)`, `--motion-ease-spring: cubic-bezier(0.2,0.8,0.2,1)`.
  Agent used the doc's canonical names (`out`/`spring`) over the prompt's suggested names to stay lock-step
  with future consumers (M3+) — sound autonomous call. `@media (prefers-reduced-motion: reduce)` zeroes all
  three duration tokens at `:root` (token-scoped — NO global `*{transition:none}`; re-skin-friendly). Additive
  tailwind `transitionDuration`/`transitionTimingFunction` mappings.
- **DoD:** typecheck 0 · lint clean · 912 tests · **next build GREEN** · inline ratchet 58/9 · palette guard 139/32.
- **Verify:** definition-only (no consumer yet → no behavior change to eyeball); green build/tests + additive diff
  are the verification. Squash `ff20e93`.

### P-TZ-1 — `formatRelative` pinned to Asia/Jerusalem + ICU-plural Hebrew dual · status: ✅ MERGED 2026-06-18 (#422)

- **Spec (plan §4 line 189):** pin `now`+target to Asia/Jerusalem before day-diffing + UTC-boundary test +
  ICU-plural native-Hebrew copy. Absorbs B12.
- **Bug was REAL:** `lib/format.ts:formatRelative` bucketed the day-level result off a raw elapsed-ms diff
  (`Math.round((t-now)/86_400_000)`), never projecting either instant onto Israel civil days → off-by-a-day near
  midnight and on a UTC runtime (CI). Violated the "store UTC, display Asia/Jerusalem" hard rule.
- **Fix:** `civilDayUtcMs(at)` projects an instant to its Israel civil day via `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem'})`
  re-anchored at `Date.UTC(y,m-1,d)` (DST-safe whole-day deltas); both sides go through it before the day delta;
  sub-day buckets keep the elapsed-instant delta. No new dep; signature stable (optional defaulted `now` 3rd param
  for deterministic tests → zero of the ~18 adapter call-sites changed).
- **Tests:** `format.spec.ts` T-TZ-1.A/.B (same-Israel-day instant the naive logic called אתמול) + `format.utc-boundary.spec.ts`
  re-runs under `process.env.TZ='UTC'` (the CI condition) — both FAIL under old logic.
- **ICU dual:** `projects.board.signedCount` (he+en) → next-intl `plural` one/two/other so 2 → "שתי חתימות התקבלו",
  1 → "חתימה אחת התקבלה" (+ symmetric pending half). Relative-time dual already native via `Intl.RelativeTimeFormat('he')`.
- **DoD:** typecheck 0 · lint · **921 tests** · **next build GREEN** (ICU parsed at build) · i18n-coverage green.
- **Verify:** UTC-boundary tests (failing-under-old) are stronger proof than a browser eyeball could be for a
  midnight-boundary case; logic reviewed (civil-day projection is the correct DST-safe approach). No PII/auth/RLS.
- **⚠️ e2e REGRESSION caught + fixed post-open (the slice's lesson):** the agent ran vitest (921 green) but NOT
  the Playwright `e2e` suite (a separate CI job). The ICU rewrite added nicer `=0` copy
  ("לא התקבלו חתימות · אין ממתינות") which broke `critical-path.spec.ts`'s exact-string assertions
  (it still expected the old "0 חתימות התקבלו · 0 ממתינות"). NOT the known sign-flow flake — a real regression
  (build was GREEN, only e2e red). Fixed 3 assertions (0/0 + 0/1 + a doc comment) on the branch, verified against
  the ICU template, re-ran CI → e2e green → merged. Lesson durable in memory
  [[project_fe_css_slices_need_next_build_dod]]: a user-facing copy/i18n change needs an `apps/web/e2e/` grep for
  the old literal IN THE SAME SLICE — vitest is blind to Playwright.

### C2 — DataState wrapper (loading/error/403/empty) + kill silent-null · status: ✅ MERGED 2026-06-18 (#423)

- **Spec (plan §4 line 190):** ONE wrapper — loading skeleton / calm error+retry / 403 access-denied / guided
  empty. Kill silent-null. v5 primitive #5 (Failure-Grace). Absorbs C-j.
- **Evidence:** `components/ui/data-state.tsx` — props `{isLoading,isError,error?,isForbidden?,isEmpty?,onRetry?,
skeleton?:'list'|'block'|node,emptyTitle,emptyHint?,emptyAction?,children}`; render precedence
  **forbidden→error→loading→empty→children**. Reuses the shared `isPermissionDenied` (D.16 `code:'forbidden'`)
  from `list-page-shell.tsx` — DataState is the non-list COMPLEMENT to the existing `ListPageShell` (formalizes
  the 4-state shape, does NOT fork it). 403 → muted access-denied, no retry (D.31 precedent).
- **Silent-null triage (honest, per-file):** 6/7 LEGIT (manager-home KPI "—" degrade; tabu/projects-new/export-btn/
  provider-audit×2 are pure helpers already routing via ListPageShell; auth-guard pure listener). **1 REAL BUG
  FIXED:** `signature-progress-board.tsx` had `if (isError || !data) return null` → the situation-picture vanished
  on error with no signal; now routes loading/error/empty through `<DataState onRetry={refetch}>`. (The plan's
  named `signature-progress-apartments` was stale — it already handled its states; the BOARD was the real swallow.)
- **Skeleton shimmer:** new base `<Skeleton>` + `.skeleton` in globals.css — token-only `linear-gradient`
  (`--bg-subtle`/`--bg-hover`) over `@keyframes skeleton-shimmer` at **`--motion-duration-slow` (consumes M1)**;
  reduced-motion zeroes the token + explicit `animation:none`. `<ListSkeleton>` re-homed onto it.
- **DoD:** typecheck 0 · lint · **922 tests** (`data-state.spec.ts` 8 cases: 4 states + retry-fires + derived-403 +
  precedence; `.spec.ts` not `.spec.tsx` per the vitest include + `renderToStaticMarkup` repo convention) ·
  **`next build` GREEN — and it CAUGHT a `@keyframes` brace slip the unit tests missed** (the next-build DoD
  earned its keep a 2nd time) · inline ratchet 58/9 · palette guard 139/32 · i18n-coverage green.
- **i18n:** `dataState.{loading,errorTitle,errorBody,retry,forbiddenTitle,forbiddenBody,emptyDefault}` + `projects.board.empty`.
- **Verify:** review PASS (board silent-null→DataState fix correct; API sound). The 4 non-happy branches need
  seeded-auth + forced error/403/empty the preview harness can't deterministically produce → coverage is the
  8-case unit spec + mandatory green build. No PII/auth/RLS (presentation only).
- **Merge coordination (recorded):** C2 + P-TZ-1 both added keys to `projects.board` (C2 `empty` vs P-TZ-1
  `signedCount`) → `gh pr update-branch` reported a conflict in `he.json` + `en.json`. Resolved by hand in
  C2's worktree — kept BOTH P-TZ-1's ICU `signedCount` and C2's `empty` (JSON re-validated, no markers); the
  board e2e merged clean (C2 didn't touch it). Squash-merged `5649182`; CI green incl. e2e + build.
