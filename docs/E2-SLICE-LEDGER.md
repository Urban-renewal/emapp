# EMAPP E2 — Build Slice Ledger

> The autonomous-run record. One section per slice; a slice is NOT "merged" until every
> DoD gate is ✅ with evidence. Plan of record: `docs/design-research/v8-final-verification/03-consolidated-master-plan.md`.
> Owner greenlit the autonomous run 2026-06-18 ("flawless · security · with documentation").

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

### PERF ⭐ — read-through cache + seeded-50 perf gate · status: PR OPEN (branch `perf/stats-cache-layer`)

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

### M0+G6 — app-root action-toast / aria-live live-region primitive · status: PR OPEN (branch `feat/e2-wave0-m0g6-action-toast`)

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
  - **PR:** <PR_URL_PLACEHOLDER> — DO NOT merge; human-lead real-Chrome 4-axis toast verify pending.
