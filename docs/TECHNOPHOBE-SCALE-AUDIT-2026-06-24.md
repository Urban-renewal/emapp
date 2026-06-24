# Technophobe-at-scale audit + decisions — 2026-06-24

Owner directive (2026-06-24): verify every key surface through the **technophobe-user lens**
(at-a-glance situation-picture at 100×, one-click legible decisions, legible error/empty states)
**before** the red-team. Method: seeded the local dev DB to **117 projects (101 active)** for org
alpha (tagged `SCALE-TEST project NNN`, reversible) and walked the cockpit surfaces as manager,
plus a read-only component audit. This is the decision record (lead, autonomous run).

## Findings (severity = technophobe-at-scale experience)

| #         | Surface                                                 | Gap                                                                                                                                                                                                                           | Severity       | Status                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1**    | Documents cockpit                                       | Board never exposed the TRUE behind total → FE derived `met = withRequirement − cappedLength` → claimed **"103 completed / 12+ behind"** at 115 projects when ~all were behind & **0 complete**. A dangerous at-a-glance LIE. | **BLOCKER**    | **FIXED — PR #536** (`projectsBehindTotal`, one source of truth; G-RT PASS; live + real-Chrome verified)                                                                                                                                                                           |
| **G2**    | Documents "כל המסמכים"                                  | Groups only the current 25-row keyset page → the project→party grouping is a per-page illusion; a project's docs split across pages; "attention-first" is within-page only. The named cautionary "flat-wall escape hatch".    | MAJOR          | QUEUED — same file as G1 (`documents-list.client.tsx`); build AFTER #536 merges to avoid conflict. Fix: reuse the in-file `usePartyDocuments` accumulate-across-pages pattern, or add an honest "showing first N — refine with facets" line.                                       |
| **G3**    | Projects fleet (`/projects`)                            | Flat dashed wall: every card's גוש/חלקה·יח״ד·חתימות = "—" (wire omits them); no attention-ranked default; the north-star "fleet of all projects" is the ONE fleet surface not using the situation-picture primitives.         | MAJOR          | DISPATCHED — disjoint from G1/G2 files. Fix: default to the existing `ProjectSegment` attention landing + populate the already-declared VM count fields; reuse `FleetSection`/`FleetTile`.                                                                                         |
| **G4**    | Signature pulse                                         | Per-project consent computed SEQUENTIALLY (`await` in a `for` over the whole active fleet, no LIMIT) → cold-cache latency risk at 101 projects.                                                                               | perf-hardening | **DEFERRED (severity corrected by live measurement, P3):** WARM = 0.21–0.25s at 101 projects (under the 1s gate). Real only on the COLD path (a consent write invalidates the org epoch) — a cold first-hit the gate excepts. Worth a `Promise.all` hardening, NOT a warm blocker. |
| **G5/G6** | Home/signatures attention caps; within-page sort labels | Overflow handoff loses ranking; "oldest" sort acts within-page.                                                                                                                                                               | MINOR          | Queued; largely resolved by G3 (attention-segment landing).                                                                                                                                                                                                                        |

## Confirmed-good at scale (no action)

- `DataState` (empty/error/loading) — one canonical, calm, non-technical treatment, reused everywhere.
- Documents cockpit DEFAULT view — correct attention-first situation-picture (after G1).
- One-click legible decisions — scoped upload deep-links, state-aware remind/campaign actions, masked-PII-with-audited-reveal.
- Projects/signatures pagination + server-side search/status/segment filters — correctly server-side.

## Decisions (lead, autonomous)

1. **G1 first, alone, as one coupled BE+FE PR (#536)** — it was the confirmed dangerous blocker; tight scope; merged on green.
2. **G3 dispatched now** (disjoint files, well-specified) to keep the pipeline full.
3. **G2 queued behind #536** (file conflict) — pick up once #536 is on main.
4. **G4 downgraded** to perf-hardening by live measurement — do NOT treat as a launch blocker; schedule the `Promise.all` hardening with G3/G2 or as its own small BE PR.
5. **api-docs:** the hand-written board-completeness response example (`gen-api-docs.ts`) is stale for the whole S2 axis (pre-existing) — spawned as a follow-up, not bundled into #536.
6. **Cleanup:** the 80 `SCALE-TEST` projects stay in local dev until the scale fixes (G2/G3) are walked, then deleted (`DELETE FROM projects WHERE name LIKE 'SCALE-TEST project %'`).

## End-of-session status (2026-06-24, after 3 machine shutdowns — all work survived via commit→push)

- **G1 — #536 MERGED.** `projectsBehindTotal` (true pre-cap count); board no longer claims "103 completed" at scale. G-RT PASS + real-Chrome verified.
- **G3 — #537 MERGED** (+ nits **#538 MERGED**: terminal-status warn-cue gate + orphaned-key cleanup + a ratchet false-positive fix). Attention-first chips on the existing `ProjectSegment`; real units/signatures render (BE wire already carried them — the builder correctly refused to re-implement). Walked at 117 projects: רסקו → "6 יח״ד · 5 מתוך 6", segment chip → `?segment=stalled` 200 @ 0.24s.
- **G2 — #539 (auto-merging).** `useAllDocumentsFeed` accumulates pages (reuses canonical `usePartyDocuments` shape) + an honesty line. Walked: honesty line 25→50 loaded after "load more", project group stayed ONE combined group. G-RT PASS (7 axes).
- **SCALE-TEST seed deleted** (37 projects restored). Re-seed for future scale walks: `INSERT … generate_series(1,80)` (see this doc's method + the commit history).

### Queued (NON-blocking — calibrated decision to NOT rush on a crash-prone host)

- **G4 (perf-hardening, not a warm blocker):** `signaturePulse` (apps/api/src/modules/projects/projects.service.ts:1540-1604) computes per-project consent SEQUENTIALLY (`await statsCache.readThrough` inside `for (const f of facts)`). Each `agg` is INDEPENDENT → parallelize. **CAVEAT: bound concurrency (chunks of ~8) — each `withTenant`/`computeConsentAggregates` takes a pool connection; an unbounded `Promise.all` over 100 projects would EXHAUST the pool and be worse.** WARM is already <0.25s (gate passes); this only helps the COLD path (a consent write bumps the org epoch → all projects recompute). Verify: signaturePulse spec (counts identical) + measure cold (invalidate epoch) before/after. Do it as its own small BE PR with measurement — not rushed.
- **G5/G6 (minor):** largely resolved by G3's attention-segment landing.
- **api-docs:** `gen-api-docs.ts` board-completeness response example is stale for the whole S2 axis (pre-existing); now also missing `projectsBehindTotal`. Small follow-up.
