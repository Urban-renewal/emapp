# 02 — Puzzle vs Rebuild (the feasibility front, grounded in real code)

> **Front:** is shipping the one-click vision **assembling a puzzle** or **building everything
> again**? **Method:** read the real tree — every cited `file:line` below was opened and verified
> against `00-FINAL-BUILD-PLAN.md` + `01-api-action-map.md`. Each slice is classed **PUZZLE**
> (endpoint + component/hook already exist — pure compose/wire/restyle), **PARTIAL** (a real spine
> exists; a bounded net-new piece is added), or **REBUILD** (genuinely net-new BE or FE).
> **Date:** 2026-06-18.

---

## THE HEADLINE VERDICT

**This is assembling a puzzle, not rebuilding the app — with four real net-new pieces and one
missing FE primitive layer.** Of the 41 build slices, the dominant mode is *compose/wire/restyle
over a substrate that already ships*. The signature spine, the consent CTE, the cron scheduler, the
RSC-prefetch data pattern, the cache provider, the resend endpoint, the campaign failure
computation, the board components — **all already exist in the tree**. The plan's own framing is
confirmed by code: the v3 "zero schedulers / build the autonomy infra" premise is **factually
wrong** (`apps/worker/src/main.ts` runs 3 live crons via a clean `IJobHandler` interface), and the
heaviest "new" gates (PERF cache, B3 autonomy) are *add-one-instance-of-an-existing-pattern*, not
greenfield.

**The honest ratio (41 slices):**

| Class | Count | Share | What it means |
|---|---|---|---|
| **PUZZLE** | **23** | **~56%** | endpoint + FE component/hook both exist → restyle/compose/wire only |
| **PARTIAL** | **13** | **~32%** | real spine + a bounded net-new BE column/route/migration or FE primitive |
| **REBUILD** | **5** | **~12%** | genuinely net-new: B1 pulse, B4 holdout, C12b console, C1 print-of-record (if server-PDF), C17 bulk |

**~88% of the work touches code that already exists.** The 12% true-rebuild is *small, bounded, and
isolated* — no rebuild item is on the critical correctness path except B1 (a read endpoint reusing
an existing CTE) and C1 (a print artifact). The certainty-gate slices (S0-SEC, B5, B0) are **all
PUZZLE-or-PARTIAL edits to existing service methods**, not new subsystems.

---

## THE LOAD-BEARING EVIDENCE (every claim opened and verified)

### The substrate that makes this a puzzle

- **The consent CTE already exists and is correct in shape.** `projects.service.ts:363-407` is a
  real multi-CTE query (`proj_apartments` → `apt_consent` → aggregate). B0 does **not** write a new
  query from scratch — it **re-bases the final arithmetic** (`:419-421`, the binary
  `apartmentsConsented/totalApartments`) onto `ownerships.share_numerator/denominator` and adds
  `GROUP BY` per building. The join skeleton, the visibility gate
  (`assertProjectVisible`), the `withTenant` wrapper, the wire shape — all stay. **PARTIAL, not
  rebuild.**
- **The cron scheduler ships.** `apps/worker/src/main.ts:245,274,309` schedules 3 live crons
  (reaper hourly, audit-retention daily, signature-expiry hourly) through a documented two-step
  idempotent wiring (`createQueue + work()` → `boss.schedule(name, cron)`). The handler contract is
  a clean interface: `SignatureExpiryHandler implements IJobHandler` with `readonly name`,
  `readonly payloadSchema`, `work()` (`signature-expiry.handler.ts:37-51`). **B3 adds ONE MORE
  handler instance of this exact shape** — it is a puzzle piece snapping into a finished frame, not
  "build a scheduler."
- **The RSC-prefetch data pattern (Pattern A) already ships on ~15 pages** — `HydrationBoundary` /
  `dehydrate` / `prefetchQuery` are live in `projects/page.tsx`, `projects/[id]/page.tsx`,
  `owners/page.tsx`, `documents/page.tsx`, `members`, `audit`, `notifications`, etc. E2.1's
  "migrate ManagerHome onto Pattern A" is **copy an established in-repo pattern**, not invent one.
- **The cache provider exists.** `packages/db/src/providers/cache/postgres.provider.ts` +
  `cache.interface.ts` + `fake.provider.ts` are real and tested; today wired only for export
  rate-limit (`export-rate-limit.service.ts`). PERF is **read-through-wire an existing provider**
  over `orgStats`/`signatureProgress` — not "build a cache layer." **PARTIAL.**
- **The resend chase endpoint ships and is audited + 409-guarded.** `signature-requests.service.ts:748`
  (`async resend`) + the controller route. M2's one-tap chase **wraps an endpoint that already
  exists** — the only FE-new piece is the `<RemindHoldoutButton>` + optimistic hook.
- **The campaign already computes the `failed` count the toast throws away.**
  `signature-requests.service.ts:482-534` builds per-owner `{outcome:'created'|'skipped_existing'|
  'failed', reason}` with real reasons (`owner_not_found`, `owner_is_renter`,
  `recipient_not_associated`, `insert_conflict`). The FE
  (`signature-campaign-action.tsx:48`) renders only `{created, skipped}`. M5's failed-surface is
  **read a field already on the wire** — nearly free. **PARTIAL** (the preview endpoint is the only
  net-new BE).
- **The board components render wire data today.** `signature-progress-board.tsx` consumes
  `useSignatureProgress`, renders the headline + `role=progressbar` bar + signed/pending counts.
  E2.2-S3 is **restyle + add the basis label + stop returning `null`** (`:36` `if (isError ||
  !data) return null` — the confirmed C2 "silent null"). **PUZZLE.**

### The true REBUILD items (be honest — these are genuinely net-new)

- **B1 pulse** (`GET /org/signature-pulse`) — **does not exist** (grep: zero matches in
  `apps/api/src`). BUT it **reuses** the `orgStats` multi-subquery + agent-scope CTE
  (`projects.service.ts:537-581`) and derives from existing
  `signature_requests.{signedAt,expiresAt,status}` columns — **net-new route, recycled SQL.** No
  migration. *REBUILD-lite.*
- **B4 holdout-name** (`GET …/apartments/:apartmentId/holdouts`) — **does not exist** (grep: zero).
  Net-new route, but it **mirrors the existing `owners/:id/reveal-pii` audit+gate model**
  (`owners.controller.ts:115`) and reuses the `signatureProgressApartments` join
  (`:456-526`, today counts-only). *REBUILD-lite, with a precedent to copy.*
- **C12b provider operator console** — `provider-tenant-users.controller.ts:59` is **read-only
  today**; MFA-reset / unlock / resend-invite are net-new BE + UI at every layer. **The only
  full-stack REBUILD**, and the plan correctly flags it a go-live blocker.
- **C1 print-of-record** — if the owner picks server-rendered audited PDF, it's a net-new BE slice
  (precedent: `signature-requests/:id/signed-document` PDF at `:112`). If print-stylesheet, it's
  FE-only PUZZLE. **Owner-gated fork; classed REBUILD to be safe.**
- **C17 bulk verbs** — `projects.controller.ts` is single-`:id` only (`@Post()` `:85`,
  `@Patch(':id')` `:94`, `@Delete(':id')` `:104`); bulk archive/status/resend are net-new routes.
  **REBUILD (BE), but trivially derived from the single-id services.**

### The missing FE primitive layer (the one real surprise — fold into Wave 0)

`components/ui/` is **lean**: `button`, `list-page-shell`, `list-skeleton`, `name-display`,
`status-badge`. There is **NO `ConfirmDialog`**, **NO `ActionToast`/toast library** (no `sonner`,
no `useToast` — grep: zero), and the step-up surface is a bespoke `components/step-up-unlock.tsx`,
not the `StepUpDialog` the plan names (M6/M5 assume a dialog primitive with an a11y contract). The
campaign action hand-rolls its own inline `toast` state (`signature-campaign-action.tsx:30`). **This
is the one place the plan slightly under-counts net-new FE work** — M0+G6 (the unified live-region)
and the `ConfirmDialog` are *building primitives*, not restyling existing ones. Still bounded (two
small components), but they are **PARTIAL→REBUILD-lite, not PUZZLE**, and **everything in Waves 2–4
that says "ConfirmDialog" / "ActionToast" / "undo" depends on them landing first.**

---

## PER-WAVE RATIO

| Wave | Puzzle | Partial | Rebuild | Read |
|---|---|---|---|---|
| **0 — Foundation/gates** (9) | E2.0, E2.0-GUARD, E2.0b, M1, P-TZ-1, C2 | PERF (wire cache), S0-SEC (pipe over existing controllers) | M0+G6 (new live-region primitive) | **mostly puzzle**; the one net-new primitive is M0+G6 |
| **1 — Structural+consent** (6) | E2.2-S1, E2-IA-S2, S4 (reuses `owners/search`), C13 | **B0** (re-base CTE arithmetic), **B5** (transition map + If-Match on existing `update()`) | — | **0 rebuild** — the two CRITICAL slices are edits to one existing method |
| **2 — BE-gated** (6) | E2.2-S3, M2 (wrap resend), E2-list | E2.1 (Pattern-A migrate), M5-FE half | **B1**, **B4** | the 2 rebuilds are read endpoints reusing existing SQL |
| **3 — Movie+autonomy** (4) | M3 (client edge-diff) | M5 (preview endpoint), B2 (1 migration + status ripple) | **B3** (one new handler — but a *puzzle into the cron frame*) | autonomy is a snap-in, not a build |
| **4 — Completeness** (16) | C5, C8, C7, C14, C15, C12, M6, C-c, C-d, C-l, N11(label path) | C16 (reuse owners/overrides controllers), C10, C11 | **C12b**, **C1**(if PDF), **C17** | the long tail is overwhelmingly restyle of existing screens/routes |

**The pattern is unmistakable:** the rebuilds cluster in the *long tail* (Wave 4 operator/ops
surfaces) and the *two read endpoints* (B1/B4). **The critical-correctness gate (Waves 0–1) contains
ZERO rebuilds** — S0-SEC, B5, B0 are all edits to existing service methods + one CI guard.

---

## CREATIVE — net-new options the plan doesn't yet exploit (buildable, grounded)

1. **The campaign PREVIEW is already 90% computed — promote it to a "dry-run mode" of the real
   endpoint, not a second route.** `signature-requests.service.ts:482-534` already classifies every
   owner into created/skipped/failed *before* the delivery tx (delivery happens "OUTSIDE the
   gate/insert tx" at `:543`). Add a `dryRun` flag that **runs the classification and returns the
   bundles without inserting** — same code path, zero divergence risk, and the preview is *guaranteed
   to match* the real send because it IS the real send minus the commit. This is strictly better
   than M5's separate `…/preview` route (which can drift). **WOW lever:** "40 ייצאו · 3 בלי טלפון ·
   1 דייר — [שלח]" rendered from the actual engine, not an estimate.

2. **B3 autonomy can ship as a *third notification-emitting wrapper around the expiry sweep that
   already runs* — not a new cron.** The expiry handler already fires hourly and already groups by
   org (`signature-expiry-sweep.ts:72-92` `UPDATE … RETURNING org_id`). Instead of adding a *new*
   consumer, **emit the 3 new notification kinds inside the existing sweep's per-org grouping** (it
   already knows which orgs had expiring rows). One handler, one cadence, the chase rides the
   hygiene sweep it's conceptually paired with. Smaller and more honest than "add ONE pg-boss cron
   consumer."

3. **The "control paradox" has a code-level answer the plan misses: the optimistic-snapshot IS the
   audit trail.** M2's undo uses the TanStack `prev` snapshot as the undo (plan §M2). Extend that —
   **every system-initiated action (B3 auto-reminder) writes the same audit row shape the manual
   resend writes** (`signature_request.resend` at `:792`). Then the activity feed renders manual and
   automatic chases *identically*, with an actor badge ("המערכת" vs "אורי"). The manager sees the
   system act *in his own ledger* — active-but-his-control, with zero new infra (the audit spine
   already exists).

4. **Make B4's holdout-reveal a *progressive* read, not a PII gate every time.** The plan models B4
   on `reveal-pii` (audited cleartext). But the holdout *name* (not national_id/phone) is far less
   sensitive. Consider a two-tier: apartment-grained ("דירה 7 · partial") needs no gate and ships
   in E2.2-S3 *today* from the existing counts-only `signatureProgressApartments`; the *name* is the
   B4 gated reveal. This lets the flagship "מי תקוע" drill-down **ship its first 80% before B4 even
   lands** — de-risking the most-visible WOW moment off the critical path.

5. **C1 print-of-record: reuse the signed-document PDF renderer, don't build a new one.**
   `signed-document.service.ts` + `pdf-signed-document.renderer.ts` already render an audited
   immutable PDF. The committee record is the *same renderer with a different template* — classing
   C1 as "net-new BE" over-counts it. It's PARTIAL (new template, existing pipeline), turning the
   scariest go-live blocker into a puzzle piece.

---

## ANSWER TO THE OWNER'S QUESTION

**"Is this assembling a puzzle or rebuilding everything?"** — **A puzzle, decisively. ~56% of
slices are pure compose/restyle over existing endpoint+component pairs; ~32% add a bounded net-new
piece to a real spine; only ~12% are genuinely net-new — and those cluster in the long-tail operator
surfaces and two read-only endpoints, NOT on the correctness-critical path.** The three certainty-gate
slices (S0-SEC, B5, B0) are edits to a *single existing service method plus one CI guard* — the
infra (CTE, cron, cache, RSC-prefetch, resend, failure-computation, audit spine) is already in the
tree and already production-grade. The one honest under-count is the **missing FE primitive layer**
(no ConfirmDialog, no toast/live-region component) — fold M0+G6 + ConfirmDialog firmly into Wave 0
as a *prerequisite*, because every confirm/undo/toast in Waves 2–4 depends on them.
