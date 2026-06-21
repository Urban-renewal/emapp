# EMAPP — Master Backlog (manager view, single source of truth)

> Updated 2026-06-18. Priority-ordered. Every UI change: green-gate + real-Chrome
> verify. Nothing merges on red; never force-merge. Audits → consolidated plans.

## ✅ Done & banked
- Perf RSC server-prefetch (13 pages, #405–409), Turbopack dev (#405), 403-handling
  fix (#410), DB_TARGET flag (#403), tmp advisory (#404).
- **E1 — interface audit** (6 roles, MISSING=0) + **flow test** (15 flows e2e,
  cross-entity propagation verified, negative tests, browser load times). See
  `docs/AUDIT-CHECKLIST.md`, `docs/E1-FLOW-TEST.md`.

## T1 — SECURITY HARDENING (active — owner's current focus)
**Audits:** validation ✅ (`SECURITY-VALIDATION-AUDIT.md`), upload ✅
(`SECURITY-UPLOAD-AUDIT.md`), OWASP Top 10 ✅ (`SECURITY-OWASP-TOP10.md`).
**CONSOLIDATED → `SECURITY-POSTURE.md`** (single posture-of-record: 9-row domain
table + one unified P0→P2 plan + owner/deploy checklist + "not-a-vuln" list).
**Headline:** foundation is genuinely strong (RLS FORCE ~36 tables + withTenant/
withProvider + 2 build ratchets + fail-closed authz, pgcrypto + AES-GCM doc
envelopes, owned argon2id auth, Helmet/CSP, SSRF allowlist, real fail-closed
ClamAV, UUID storage keys, zip-bomb preflight, national_id IS server-validated).
No OWASP category rates Weak. Systemic gap is structural not a live hole: no global
pipe / no CI coverage guard → validation present by convention, not by construction.
**Two conscious sign-off items (surfaced 06-18):** export rate-limit fails OPEN;
cookies `sameSite=lax`. Decide accept-vs-harden before go-live.

**Fixes (browser-verified on a CLEAN dev build — the stale prod build caused false
"bugs"; see env note below):**
- F-3 ✅ **MERGED #412** — duplicate-409 PII-oracle → generic + a11y + client Luhn.
  Browser-verified (invalid national_id → inline error, no submit). Minor follow-up:
  the Luhn error string renders in ENGLISH ("national_id failed the Israeli ID
  checksum") — localize to Hebrew.
- F-1 🔄 #413 — ~18 native `window.confirm` → one styled `ConfirmDialog`. Browser-
  VERIFIED (owner archive shows the styled dialog, cancel = no-op). Found+fixed a
  REAL e2e regression: `j16` reactivate test accepted a native dialog that's now in-
  DOM → drive the dialog's confirm button (commit aa4e504). CI re-running → merge on
  green. (j11 AccessReasonGate failure was a retry-flake.)
- Magic-byte — agent died after ~40min without committing; its WIP is **preserved in
  `git stash@{0}` (magic-byte-wip-preserved)**. Re-verify on its own branch + PR
  cleanly (serialized). magic-bytes.ts + spec + service/storage/shared-types edits.

**Env note (proven this session):** the running web was a STALE prod build (`next
start`, frozen before F-1/magic-byte) → the owner-archive "freeze" + documents `503`
were BOTH stale-build artifacts, NOT product bugs (both render clean on a fresh
build). Restored a clean env: stashed magic-byte WIP → restarted web as `next dev` on
clean F-1. Also: recurring **session expiry every few min** in dev (short token TTL vs
human-paced gaps) — batch actions fast or the session lapses mid-flow.

**Campaign→sign chain — verified every layer** (clean build): create form ✅, doc
selection ✅, **owner-dropdown filters to the doc's apartment** ✅, server validation
(owner↔apartment) ✅, **duplicate-prevention 409** ✅, sign UI ✅, real share data ✅
(דנה כהן 100% / 10000·10000). Minor: an apartment-less doc (`apartmentId:null`) is
still SELECTABLE in the form → any owner rejected with a misleading message.

**Design council v2 done** → `docs/design-research/v2/` (8 expert + 3 critique +
`00-MASTER-PLAN-V2.md`); 5 owner decisions LOCKED → `v2/DECISIONS-LOCKED.md`.
**Security posture consolidated** → `docs/SECURITY-POSTURE.md`.

**P0 (next slice):** un-skippable validation — global `APP_PIPE` + a CI guard
(`input-validation-coverage.spec.ts`, modeled on `api-docs-coverage.spec.ts`).
**P1:** `.strict()` on the 13 `List*Query` schemas · `isValidIsraeliPhone` into the
OTP schema · normalize provider `ParseUUIDPipe` → Zod.
**P2:** per-field array caps · per-route body limits (OTP/login) · `.max()` on the
public-sign token param · move doc scan inline→worker (latency).
**Owner / deploy (pre-go-live):** provision `FILE_SCAN_CLAMAV_HOST` (reachable,
`StreamMaxLength ≥ 50MB`) + an EICAR smoke. ClamAV is real + fail-closed (prod
won't boot without it) — just confirm the host.

## T2 — E2 PRODUCT REDESIGN (parked behind T1; owner-loved direction)
Master plan `docs/design-research/00-MASTER-PLAN.md` (6-expert panel). Locked
visual = mockup v4 (metric cards + threshold-marker bars + momentum/why + triage,
calm/plain for the low-tech developer). North star `docs/DESIGN-NORTH-STAR.md`.
Open draft: **PR #411** (home mission-control). Slices: E2.0 token foundation →
E2.1 home → E2.2 project page → E2.3 chase loop. Start after T1 settles; needs T4.

## T3 — E3 PROVIDER OPERATOR (parked)
Console operator-half absent (`docs/perf-research/PROVIDER-ADMIN-AUDIT.md`).
P0 user-recovery slice started (`feat/provider-user-recovery`) then parked.
Impersonation dropped per owner.

## T4 — CONSENT CORRECTNESS P0 (needs OWNER decision)
Consent counting ignores registered ownership-share (`ownerships.share_*`, stored,
unused) — the legal majority is multi-dimensional, so 66% can be legally wrong.
**Owner must confirm the counting rule per project type (heads vs ownership-share
vs per-building)** before this is fixed.

## Findings register (feed T1)
F-1 native confirm · F-2 PII reveal no step-up (verify) · F-3 ✅ duplicate-409 PII
oracle (fixed) · F-3b national_id client UX (server already enforces) · magic-byte
on doc upload. Detail: `docs/E1-FLOW-TEST.md` + the SECURITY-*.md audits.

## Misc / owner-gated
Railway==Neon region (infra) · archive 2 junk owners (consent) · GovMap parcel
(post-prod) · seed `admin@provider.dev` vs `provider@local.dev` mismatch.

---
### Operating notes (manager)
- Agent completions wake me instantly (event-driven) — I do NOT idle on the
  fallback timer; keep wakeups minimal, rely on notifications.
- Concurrent fix-agents share one working tree → verify/merge ONE branch at a time
  (the pre-commit lint-staged hook can sweep cross-branch changes).
- QA lesson: browser-DOM error capture can miss messages (selector-dependent);
  pair it with code-level analysis for the precise mechanism.
- QA lesson (06-18, owner): finish the FULL read-only Chrome test → full picture
  → ONLY THEN dispatch fix-agents. Never browser-test while agents churn the tree.
- Dev-server compiled-cache contamination: `next dev` does NOT recompile on a git
  branch switch / mixed working tree → it serves a Frankenstein of compiled modules
  from different branch states. Proven this session: documents/[id] 503 (magic-byte's
  uncommitted shared-types edit) + owner-archive native-confirm freeze (stale
  pre-F-1 module). BOTH dev-artifacts, NOT product bugs — F-1 source verified correct
  (`becce1d`, useConfirm, zero window.confirm in app code). Browser results on a
  contaminated dev server are invalid; require a clean rebuild first.
- Per-agent DoD (owner 06-18): every fix-agent must self-certify it didn't regress
  security / the cross-entity chain / runtime — THEN the lead independently verifies.
