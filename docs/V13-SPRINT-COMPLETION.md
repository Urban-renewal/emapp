# V13 Turbo Sprint — Completion Summary (owner welcome-back)

> Single-page status for your return. The git log is the full ledger; this is the **decision queue**
> + what shipped. Companion: `docs/V13-ACCEPTANCE-CHECKLIST.md` (verification log), `docs/MASTER-PLAN-V13.md`.

## ✅ Shipped to `main` this sprint
| PR | Slice | Notes |
|----|-------|-------|
| #426/#428/#436 etc | BE foundation: DH1 doc-taxonomy · NS1 server-search · BM-1 leverage · external_share | migrations 0077–0079 renumbered clean; security HIGH fixed pre-merge |
| #457 | **Hydration fix** on the board-first home (centerpiece) | `useId()` → stable id; killed the one real console error |
| #459 | **DH2** project document-checklist (advisory) | no migration; RLS-tested; security PASS |
| #461 | **DH3** heuristic document classifier (suggest-only) | merging on green |
| #462 | **DH4** document dedup probe (link-to-existing) | merging on green; CI seed bug fixed-forward |
| #460 | **Perf:** ipv4-first DNS + per-role `<1s` QA harness | see Perf below |
| #442 / #444 | **Reskins:** tenant portal + provider subtree | both walk-verified + palette-guard green |
| #448 / #456 / #458 | Council decision doc · acceptance checklist · verification log | — |

## ⏳ Verification — all 6 tiers green (runtime axes)
Manager · Agent · Viewer · Provider · Tenant walked on the real stack (loads · no-bounce · no-console-error
· no-failed-network · PII-masked · role-gated) via the **Playwright real-stack harness**
(`apps/web/e2e/audit/{role,provider,tenant}-coverage.spec.ts`) — the reliable real-browser path, since the
MCP Chrome tab drops session cookies. Contractor + public-signer covered by prior walks + CI e2e.

## ⚡ Perf — fixed + diagnosed (#460)
The dev `>1s` was a **`localhost`→IPv6 `[::1]` resolution penalty** (~0.2s/connection; the API itself is
23ms via 127.0.0.1). Compounded across the SSR's server-side hops → ~1.6s home. Fix: `ipv4first` DNS in
both server entry points. **Residual dev cost is the Next dev-mode route-handler proxy (~0.6s/call) — a
`next dev` characteristic; production (precompiled + CF proxy) is sub-200ms.** → **For real perf QA, run a
local prod build** (`start-prod-local.ps1`), not `next dev`. The `<1s` budget is now measured in every role
walk (`[PERF>1s]` flag).

## 🟡 YOUR DECISION QUEUE (held — nothing force-merged while you were away)
1. **NS2 #463 (DRAFT)** — PII-gated national_id lookup. It broke locked test `DV-8` by gating *all*
   national_id search behind `view_owner_pii`, which removes agents' **in-scope** ID search — a **capability
   matrix change (Gate-2)**. Per MASTER-PLAN the gate belongs on the *cross-project widening*, not the basic
   match. PR has the recommended fix. **Your call on the matrix**, then re-run @security-reviewer.
2. **Gate-6 migrations (parked):** NS3 (saved_view) · X-S4 (external_share_otp + session tables). These need
   your migration approval.
3. **X-S5 watermark** — feasibility STOP: the watermark *storage* is merged, but the *delivery path* it
   overlays (external-recipient authenticated sensitive download) doesn't exist — it's blocked on **X-S4**
   (migration) + a recipient download endpoint (X-S6/X-S7). Build order: X-S4 → recipient download → X-S5.
4. **Fleet-vision FE (north-star) + leverage card** — new UI; needs your GO. (Manual MCP-Chrome QA is
   blocked by the cookie-drop; QA via the Playwright harness.)

## Guardrails held throughout
Never deviated from locked spec (auth/RLS/PII/matrix) · no risky migrations while away · no un-QA'd FE
merges · every blocker root-caused + fixed-forward or held with a note (D.51, never papered over).
