# E2 Merge Gate — the real-Chrome QA is mandatory and structurally unmissable

> Owner directive (2026-06-19): after every agent finishes, the orchestrator runs a **real-Chrome QA**
> pass on the slice — through the actual user experience in the owner's Chrome (NOT headless Chromium /
> MSW) — covering security, runtime, and error-handling like a real QA, fixing anything that surfaces,
> BEFORE merge. "איך אתה יכול לתקוע את זה כחלק מהפלואו שבטוח זה לא יתפספס?" — this doc is the answer.

## The hole this closes

`gh pr merge --auto` merges the instant CI is green — BEFORE any real-browser QA. Auto-merge is the
bypass that lets a browser-class bug reach `main` and forces double work. **Therefore: auto-merge is
BANNED for any browser-observable slice.** A UI change reaches `main` ONLY via the orchestrator's
explicit `gh pr merge`, and that is never typed until the QA walk below is done. No auto-merge ⇒ no
bypass exists ⇒ the QA cannot be skipped.

## The gate — in order; a slice is NOT merged until every step passes

1. **CI green** — typecheck · lint · test · build · e2e · conformance · security-scan · secrets.
2. **Orchestrator code review** — root-cause (D.51), DoD met, no PII in logs/errors, RLS/`withTenant`/auth intact.
3. **REAL-CHROME QA WALK** (the unmissable step). Run the BRANCH on the real dev server (`:3001` → real API
   `:3000`) and drive it in the owner's actual Chrome (Claude-in-Chrome MCP), as each affected role —
   **never** `fetch()`/`eval()`/`window.location` to fake it (computed-style/DOM reads for verification are
   fine; CDP screenshots are flaky here, so verify via DOM/network/interaction):
   - **Render / UX** — the change renders + behaves correctly through the real user experience (navigate,
     click/type as the role; the thing actually works, looks right, RTL intact).
   - **Network** (`read_network`) — the right calls fire with the right shape; no missing, duplicated, or
     runaway requests.
   - **Console** (`read_console`) — zero errors.
   - **Error-handling** — trigger the failure / edge paths (403 · empty · conflict/`stale_write` ·
     validation · network error) and confirm calm, graceful handling (DataState / clear message), never a
     blank screen or a raw error dump.
   - **Runtime / perf** — loads without obvious jank; no request storm; warm navigation is reasonable.
   - **Security** — no PII in DOM/URL/network where it must be masked; forms keep `method="post"`; no
     auth/role bypass; the role sees ONLY what it should.
   - **Fix-forward** — any finding → fix on the branch + RE-WALK. Never merge with an open finding.
4. **Ledger evidence** — the slice's `docs/E2-SLICE-LEDGER.md` entry carries the QA line: _role(s) walked ·
   what was checked · verdict PASS_. **No evidence line = not merged.**
5. **PR checkbox** — the PR body carries `- [ ] real-Chrome QA (orchestrator)`; checked off only after the
   walk, so the QA status is auditable per-PR.
6. **Merge** — explicit `gh pr merge --squash` (NO `--auto`), then the slice's task → completed.

## Exemption — pure-BE slices only, and only when JUSTIFIED

A slice with NO browser-observable surface is exempt from step 3. "No surface" must be PROVEN, not assumed:
grep for any FE call site of the changed endpoint/behavior and show it's empty (e.g. B5: the project-update
PATCH had zero UI callers). The justification goes in the ledger. Such slices MAY `--auto` merge on green;
their unit/integration tests + security-review are the gate. The moment a UI consumes that surface, the
real-Chrome walk applies.

## Why this is unmissable

The only door to `main` for a UI change is the orchestrator's hand on `gh pr merge`, and that hand always
walks the gate first (auto-merge — the only skip-path — is banned). The ledger evidence line + the PR
checkbox make a skipped walk VISIBLE after the fact. Discipline + no-bypass + audit trail = it can't quietly
slip.
