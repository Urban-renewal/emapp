# EMAPP — Autonomous Backlog (single source of truth for the no-stop run)

Living, ordered queue of every open task. Worked top-to-bottom, one at a time,
each via the fixed pattern. Updated in-place as items move. The companion
`AUTONOMOUS-PROGRESS.md` is the decision log; this file is the QUEUE + status.

## The per-task pattern (Definition of Done)

For every item, in order — never skip a step:

1. **VERIFY** the finding at file:line first (3 audit findings were FALSE — H1, M5;
   2 partly over-claimed — H2, M2). If it's not real → mark `refuted`, correct the
   audit doc, move on. Do NOT fabricate a fix.
2. **DECIDE** — if it needs a product/policy call, apply the Charter rule (below);
   never silently stall.
3. **IMPLEMENT** the root-cause fix (not a plaster — D.51).
4. **TEST** — typecheck + lint + targeted tests green (real DB via Infisical when needed).
5. **SECURITY-REVIEW** if it touches PII / auth / RLS / policy / export / external input.
6. **PR** → push → **CI green** → **merge** (per Charter) → sync main.
7. **DOCUMENT** the outcome in AUTONOMOUS-PROGRESS.md; update this file's status.
8. **NEXT** — move to the next `todo` automatically. No "what's next?" question.

Stop ONLY when: the queue has no `todo`/`doing` left, OR an item is `blocked` on a
hard external dependency (a human must look at something I cannot observe). A
`blocked` item is documented and SKIPPED — the run continues with the next item.

## Status legend

`todo` · `doing` · `done` (merged) · `refuted` (false finding, corrected) ·
`blocked:<reason>` (skipped, needs the owner)

---

## DONE this session (7 PRs merged)

- ✅ H3 provider login-failure audit (#252) · H2 calendar ICS (#253) · M6 import
  /start enqueue retry (#254) · L1 provider-audit URL scrub (#255) · M1 otp_codes
  RLS (#256) · in-app notifications + scanner fix (#252) · Sentry-DSN guard (#251).
- ❌ H1 **refuted** (manager-only via requireManager) · M5 **refuted** (provisioning
  works via the org Owner) · L3 doc corrected · H2/M2 framing corrected.

---

## QUEUE (priority order)

### Tier A — real, implementable now (mostly non-Gate-6)

- [ ] **A1 · L8** — `AUTH_DEBUG_ERRORS` can echo pg detail/hint to clients in staging.
      Gate it to never leak in any deployed env (prod already fail-closed). `todo`
- [ ] **A2 · M4** — security-critical auth paths under-tested (provider login/rotation/
      reuse CI-skipped; tenant OTP rate-limit/lockout/replay/real-success; refresh
      reuse-chain-purge; concurrent double-refresh TOCTOU). Add the missing tests.
      Some need a provider-user seed harness (the same gap H3's test hit). `todo`
- [ ] **A3 · L4** — share schema defines unused `tenants{national_id}`/`notes`/`team`
      perms (dead; a national_id field in a contractor-grant schema is a footgun).
      Remove if truly unreferenced (shared-types → Gate-6 if the type narrows). `todo`
- [ ] **A4 · L2** — re-evaluate the "cleartext national_id" JSDoc in export.service.ts
      (nuanced: accurate for the full-fidelity manager path; clarify, don't invert). `todo`

### Tier B — large / foundational (unblocks several LOWs)

- [ ] **B1 · H4** — no scheduler. Build the periodic runner → unblocks: R2 PII-byte
      purge-retry (the real retention leak), signature-expiry finalize+notify (L6),
      tasks overdue firing (L7), and table reapers (L5). Big; design-first. `todo`
  - [ ] L5 unbounded table growth (auth_sessions/tenant_sessions/otp_codes/cache_kv/
        notifications reapers) — rides on B1. `todo`
  - [ ] L6 signature_requests no `expired` status/transition/notify — rides on B1. `todo`
  - [ ] L7 tasks `dueAt`/overdue computes a badge but nothing fires — rides on B1. `todo`

### Tier C — needs an owner decision (Charter decides default vs skip)

- [ ] **C1 · M2** — export authz policy: is agent-scoped masked export IN/OUT? is Viewer
      export IN/OUT? Entangled with `export.run ⇒ <r>.read` closure (naive grant
      re-grants governance reads). Align catalog+controller+FE+D.54 to one answer. `todo`
- [ ] **C2 · M3** — import set-replace silently end-dates pre-existing owners (by-design
      D.25, mitigated by preview). Verify; likely document-only, maybe a confirm-copy. `todo`

### Tier D — destructive / blocked on the owner

- [ ] **D1 · Import UNDO** (D-A3) — reverses core who-owns-what data (DELETE/revive).
      Ledger RECORDING is safe/additive; the delete endpoint is gated behind owner
      review. `blocked:owner-review-on-delete-endpoint` (build the additive ledger only)
- [ ] **D2 · Hebrew signed-PDF** (B-A1) — render looks like a mess; I cannot verify a
      candidate visually. `blocked:needs-owner-visual-eyeball`

### Residue from refuted findings (document-only, no fix)

- H1 residue: engine coarse grant wider than the effective requireManager gate (LOW,
  not exploitable). M5 residue: engine `Admin` role unreachable (not an MVP role; Owner
  covers governance) + non-primary managers lack governance (intended §11.1).

---

## CHARTER (standing pre-authorizations — fills in from the owner's one-time grant)

> Granted by the owner 2026-06-06. These REMOVE the stop conditions so the run is
> continuous. Any future session inherits these rules.

- **Gate-6 merges (migrations/RLS/schema/policy):** SELF-MERGE authorized after
  (a) CI green AND (b) security-review returns PASS with 0 CRITICAL / 0 HIGH.
  Owner delegated the choice ("most efficient") — this supersedes the standing
  "ask on RLS/schema" rule for THIS run. Guardrail: if a security-review returns
  CRITICAL/HIGH I cannot fully resolve, STOP that item and present it (don't merge).
- **Product/policy decisions (e.g. M2):** pick the most-defensible default per the
  spec/DECISIONS, IMPLEMENT it, and DOCUMENT the decision in AUTONOMOUS-PROGRESS.md.
  Never stall for a decision. The owner can revise later.
- **Scope:** do EVERYTHING incl. H4 (scheduler) and all Tier A/B/C. For data-DELETION
  (import UNDO / D1): build ONLY the additive `import_changes` ledger (safe, recording
  only). The DELETE/revive endpoint stays UNBUILT/gated behind owner review. Hebrew
  PDF (D2) stays `blocked` (I can't verify a render visually) — skip + document.
- **Always-on rails (non-negotiable):** verify-before-fix (refute false findings, don't
  fabricate); security-review on PII/auth/RLS/policy/export/external-input diffs;
  CI-green before merge; document every decision; ONE task at a time; no `--no-verify`;
  no ScheduleWakeup (work in-turn — waiting is forbidden).
