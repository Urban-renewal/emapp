# 04 — Production-at-Scale: Control-vs-Chaos Red-Team

> **Front:** "50 customers, hundreds of projects, thousands of owners — is there CONTROL, or beautiful chaos?"
> **Method:** READ-ONLY code audit, every claim file:line-cited. Glob-enumerated the real tree (47 controllers, the worker, the provider console) — did NOT trust the roadmap's lists.
> **Author:** Scale-control red-team seat, 2026-06-18.
> **Verdict line:** `control-PARTIAL` — the **forensic + kill-switch + per-recipient-outcome spine is genuinely production-grade and BETTER than the roadmap claims**; the **operator/recovery + list-level-triage + chase-clock layer is the real hole**. This is not "beautiful chaos" — it is a strong governance core with a missing operations half. Two of the lead's "known gaps" are already CLOSED in code and must be struck from the build plan.

---

## GAP SUMMARY — ranked by production impact

| # | Gap | Sev | What exists today | The chaos at scale |
|---|---|---|---|---|
| **G1** | **No tenant-user account recovery** (operator console) | **P0** | Provider users page is read-only (`provider-tenant-users.controller.ts:59`, docstring "no member actions … Gate-6"). 3 mutate verbs only: onboard/suspend/reactivate. | First lockout ticket (manager loses MFA device) = a developer with DB access, not the Provider Admin. At 50 customers this is a **weekly** event with no UI/API path. |
| **G2** | **No project status-transition guard** | **P0** | `projects.service.ts:773` — `patch.status = input.status`, any→any, no state machine, no `metThreshold` precondition. | A project jumps `planning → approved` with 3% signed. `approved` is the legal "you can file" state. At scale, status becomes untrustworthy noise; no audit of *illegal* transitions because they aren't illegal. |
| **G3** | **Consent % is binary by-heads, not share-weighted** — and it is the load-bearing legal boolean | **P0** | `projects.service.ts:419-421` — `apartmentsConsented/totalApartments`; `metThreshold` (`:421`) drives the whole UI. No share-weighting, no per-building, no SHELL-denominator handling. | The number a יזם shows a וועדה/lawyer can be **legally wrong**. A printed tally with a wrong denominator is the single most dangerous output the product can emit. (Roadmap B0 — correctly scoped.) |
| **G4** | **The clock CHASES nothing** — scheduler exists but only EXPIRES | **P1** | Scheduler IS real (correction below): pg-boss cron, 3 consumers (`signature-expiry.handler.ts` hourly, reaper hourly, audit-retention daily). But expiry **emits no notification** — `:59` logs a count only. No `expiring`/`stalled`/`threshold_reached` kinds (`notification-links.ts:14-27` has document/apartment/note/task/shares/message ONLY). | Links lapse silently. No "expiring in 3 days" nudge, no "stalled 14 days" surfacing. The "autonomous" promise has **timekeeping infra but no chase output**. The owner's autonomy doctrine is half-wired. |
| **G5** | **No list-level triage / bulk operations / saved views** | **P1** | `projects.controller.ts` = single `@Post`/`@Patch(:id)`/`@Delete(:id)` only. No bulk archive, bulk status, bulk resend, no multi-project pulse aggregation endpoint (grep for `pulse` in projects = **0 files**). | At 200 projects a manager cannot triage ("show me everything expiring this week across all projects"), cannot act on 30 stalled projects at once, cannot save a filter. Every action is one-row-at-a-time. This is where calm-minimal-actions **inverts** into per-row drudgery at scale. |
| **G6** | **No optimistic-concurrency on project edits** | **P1** | `projects.service.ts` `update()` has NO version/If-Match check (only sets `updatedAt`). Contrast: signature-request create DOES 409 (`recipient_not_associated`, `signature_request_*`). | Two agents edit the same project → silent last-write-wins, no 409, no "X changed this." The roadmap's "the calm 409" assumes a 409 exists for project edits; **it does not.** |
| **G7** | **No consent-REVOCATION workflow distinct from full erasure** | **P1** | Erasure exists (`data-subject.service.ts` crypto-shred + retain legal record) and is strong. But "I signed and now withdraw" has only the nuclear erase path; no "mark this signature withdrawn / objected" lifecycle. | An owner who revokes consent post-signature forces either nothing-happens or a full GDPR crypto-shred. No middle, auditable "withdrawn" state. (Related to roadmap B2 `declined`, but that's pre-signature objection, not post-signature revocation.) |
| **G8** | **System-health is a gauge with no action + alerting fail-OPEN** | **P1** | `provider-system-health` is read-only (no drain/retry/kill). Alert sink real (`WebhookAlertSink`) but **fail-open to Noop if `ALERT_WEBHOOK_URL` unset** (`observability.factory.spec.ts:5-20`) — prod-missing = LOUD warn + Sentry, but still Noop. | Operator SEES queue depth but cannot drain/retry failed jobs. If the webhook isn't provisioned, failed-login bursts and breach signals go to a Noop. Visible-but-un-actionable. |
| **G9** | **No feature flags / kill-switches below org-suspension** | **P2** | The ONLY runtime kill-switch is org suspend (`provider-tenant-suspension.service.ts`, freezes both tiers atomically — and it's GOOD). No per-feature flag, no maintenance mode, no "disable campaign send platform-wide." | If campaign-send misbehaves (email-bomb, bad provider), the only blunt instrument is suspending a whole customer. No surgical disable. |
| **G10** | **Heavy aggregations are correlated-subquery COUNTs, unbounded** | **P2** | `orgStats` (`:537-581`) = 4-6 COUNT subqueries over ALL `signature_requests`/`ownerships`, no per-project breakdown. `signatureProgress` (`:363-407`) = nested correlated subqueries per apartment. | Fine at MVP; at thousands of owners × hundreds of projects these are full-scan-prone. No materialized rollup, no caching on these paths. The "where do my 5 projects stand RIGHT NOW" question requires N separate `signatureProgress` calls — there is no batch endpoint. |

---

## TWO CORRECTIONS TO THE LEAD'S DIAGNOSIS (strike from the build plan)

1. **"No scheduler/cron at all (nothing chases/expires on a clock)" — FALSE.** A real pg-boss cron scheduler is live with **three** periodic consumers: `signature-expiry.handler.ts` (hourly, flips lapsed `pending→expired`, `main.ts:309`), `reaper:expired-rows` (hourly, `main.ts:245`), `retention:audit-log` (daily, `main.ts:274`). The roadmap (`00-FINAL-ROADMAP.md` B3, "zero schedulers today" / "NET-NEW infra") is **wrong** — the infra exists; what's missing is the **chase OUTPUT** (notification emission on expiry/stall), not the clock. B3 should be re-scoped from "build a scheduler" to "add a 4th consumer + 3 notification kinds + their FE deep-links." This is materially smaller and de-risks the autonomy story.

2. **"Provider operator console is half-built" — CONFIRMED, and the audit (`PROVIDER-ADMIN-AUDIT.md`) already nailed it.** The governance half (onboard/suspend/reactivate + cross-tenant audit + reason-gated forensic spine) is real and solid; the support/recovery half (unlock, MFA reset, resend invite, impersonate, cross-tenant person search) is absent at every layer. G1 above is this. No new finding — it ratifies the audit's P0.

---

## SCENARIO WALK — control / discernment / recovery per real-world chaos

**1. Owner who signed REVOKES consent.** EXISTS: crypto-shred erasure (`data-subject.service.ts`, retains non-PII legal record, append-only `erasure_log`, manager-gated, audited) + the append-only `pii_processing_consents` with notice-hash. GAP (**G7**): no auditable "withdrawn / objected post-signature" lifecycle short of full erasure. Verdict: **recoverable but blunt** — the only tool is the nuclear one.

**2. Signature link leaks / is forwarded / expires unused.** EXISTS, **strong**: atomic single-use blacklist (`public-sign.service.ts:258`, `UPDATE…WHERE jti=? AND status=pending`), no-oracle responses for wrong/expired/consumed/cancelled (`:59`), token never logged (pino redact), hourly expiry sweep. A forwarded link is single-use and self-expiring. Verdict: **full control.** Not a gap.

**3. Excel import: 200 bad/dup rows / wrong national_ids.** EXISTS, **strong**: per-row structured error codes (`row-validator.ts:47-52` — invalid_luhn, invalid_phone, empty_required, duplicate_national_id, invalid_ownership_pct) → `import_job_errors` inventory; job lifecycle done/failed/cancelled (`import-job.handler.ts`); partial-success (good rows persist, bad rows reported). Verdict: **control with discernment.** Not a gap.

**4. Two agents edit the same project / send the same campaign concurrently.** SPLIT. Campaign/bulk send IS guarded: dedup (skip owner with live pending), `recipient_not_associated` 409, per-owner outcome report (`signature-requests.service.ts:482-571` — created/skipped_existing/failed+reason). BUT project *edit* has **no optimistic-concurrency** (**G6**) — silent last-write-wins, no 409 surfaced. Verdict: **campaign = controlled; edit = silent clobber.**

**5. Contractor disputes / share link must be revoked.** EXISTS: shares service has revoke; contractor read path is token-gated with lifecycle status. (Roadmap C7 notes the FE collapses lifecycle to one opaque `invalidLink` — a *display* gap, not a control gap.) Verdict: **control exists; surfacing is thin.**

**6. SMS/email/ClamAV/R2 provider DOWN.** PARTIAL. Email/SMS = best-effort per-channel with explicit `email_send_failed`/`sms_send_failed` reasons surfaced in the bulk outcome report (`signature-link-delivery.ts:402,433`) — failures are VISIBLE per recipient and the request still exists (re-deliverable via resend). ClamAV = fail-closed by design (`scan-provider.factory.ts` — prod refuses to boot without a real scanner; download gate refuses non-`clean`). GAP: a *runtime* ClamAV outage (host configured but unreachable) blocks finalize/upload — there is no "documents stuck pending-scan" queue/retry surface or operator visibility for it (**part of G8**). Verdict: **delivery failures controlled + visible; scan-outage recovery un-surfaced.**

**7. Customer escalates "where do my 5 projects stand RIGHT NOW."** GAP (**G5/G10**). No batch/pulse endpoint — answering requires N separate `signatureProgress` calls, each a nested-subquery aggregation; `orgStats` is org-wide totals only, no per-project breakdown. At scale this is slow and there's no single triage surface. Verdict: **answerable but un-aggregated — chaos-prone at volume.**

**8. Provider-Admin must unlock a manager / reset MFA / suspend a tenant.** SPLIT. Suspend/reactivate = **excellent** (atomic both-tier session revoke, idempotent freeze time, audited). Unlock/MFA-reset/resend-invite/deactivate = **absent at every layer** (**G1**, the #1 operator gap). Verdict: **gatekeeping yes; human-operations no.**

**9. DB load + heavy aggregations under many projects.** GAP (**G10**). Correlated-subquery COUNTs, no rollup/cache on the hot dashboard paths, no per-project batch. Verdict: **works at MVP, scan-risk at scale, no mitigation in place.**

**10. Owner disputes "I never signed" (non-repudiation).** EXISTS, **strong**: signature row + IP/UA provenance + notice version + **SHA-256 of the exact notice text** + append-only `pii_processing_consents` (migration 0059 REVOKEs UPDATE/DELETE) + dual forensic `audit_log` rows (`signature.signed` + `pii_consent.recorded`, `public-sign.service.ts:431-459`). Verdict: **full control — self-verifying even if the org later edits its notice copy.** Not a gap.

---

## THE MISSING CONTROL PRIMITIVES AT SCALE (the brutal list)

- **Bulk operations:** none at list level. Single-row only on projects. (**G5**)
- **List-level triage / filter / saved views:** none persisted; no cross-project "expiring/stalled" aggregation endpoint. (**G5/G10**)
- **Operator console (the support half):** unlock / MFA-reset / resend-invite / deactivate / impersonate / cross-tenant person search — **zero**. (**G1**)
- **Alerting/monitoring:** alert sink exists but **fail-open** (Noop if webhook unset) and health is read-only — no alert→action path, no job-retry/drain affordance. (**G8**)
- **Error-recovery flows:** delivery-failure recovery exists (resend); **scan-outage / stuck-document** recovery does not. (**G6/G8**)
- **Kill-switches/feature-flags:** only org-suspend (blunt, whole-tenant). No surgical per-feature disable / maintenance mode. (**G9**)
- **Support tooling:** no ticketing, no impersonation, no platform metrics (one health dot). (`PROVIDER-ADMIN-AUDIT.md` P1.4/P1.7)

---

## What is genuinely PRODUCTION-GRADE today (give credit — it changes the verdict)

- **Forensic spine:** every provider action reason-gated + audited (`withProvider`); every signature dual-audited with self-verifying notice hash; append-only consent + erasure logs. Non-repudiation is real.
- **Kill-switch that works:** org suspend atomically revokes both org + tenant sessions in one audited tx.
- **Per-recipient outcome honesty:** bulk/campaign send reports created/skipped/failed+reason per owner — no silent fan-out.
- **Fail-closed security:** ClamAV + magic-byte both fail-closed; prod refuses to boot without a real scanner.
- **The clock IS running:** pg-boss cron with expiry/reaper/retention sweeps, idempotent across deploys, concurrency-1 to avoid races.
- **Privacy-law operations:** data export + crypto-shred erasure, manager-gated, audited.

---

## SINGLE MOST IMPORTANT THING TO CLOSE

**The operator/recovery half (G1) + the status-transition guard (G2) — in that order.** G1 because at 50 customers the first MFA-lockout is days away and today it requires a developer with raw DB access (an operational AND a security-blast-radius problem). G2 because `approved` is a *legal* state and any-→-any transitions with no `metThreshold` precondition let the product assert a false legal posture at scale. Both are small, well-scoped, and unblocked — and both are the difference between "control" and "beautiful chaos" when reality bites.
