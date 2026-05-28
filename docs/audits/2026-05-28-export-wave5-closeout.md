# Wave 5 — Export Audit Closeout + Wave 6 Plan (2026-05-28)

## Inputs

Three parallel audit reports on the V11 export endpoints (B.S8–B.S10):

- `docs/audits/2026-05-28-export-redteam.md` — 1 CRITICAL, 3 HIGH, 3 MEDIUM, 3 LOW
- `docs/audits/2026-05-28-export-perf.md` — 1 CRITICAL, 1 HIGH, 5 MEDIUM
- `docs/audits/2026-05-28-export-errors.md` — 3 CRITICAL, 4 HIGH, 5 MEDIUM, 3 LOW

**5 CRITICAL findings total.** All have fix-PRs in flight; one regression discovered + fixed during the suite re-run.

## Wave 5 — fix-PRs shipped (all 5 CRITICALs)

| PR   | Severity    | Audit ID   | Title                                                                      |
| ---- | ----------- | ---------- | -------------------------------------------------------------------------- |
| #154 | regression  | —          | imports.s8 A6 — filter audit row by action (post-#151 fallout)             |
| #155 | CRITICAL    | EXP-C1     | xlsx formula injection neutraliser (`'`-prefix on dangerous leading chars) |
| #156 | CRITICAL    | E-C3       | D.16 envelope `message` present on export errors                           |
| #157 | CRITICAL    | F1         | singleton Chromium for PDF export (sub-1s warm path, satisfies CLAUDE.md)  |
| #158 | CRITICAL ×2 | E-C1, E-C2 | split export audit (requested + delivered/failed) + drop PII heap refs     |

Net wall-time win on the `format=pdf` path: ~1500 ms → ~500 ms (PR #157 alone).
Net PII surface reduction: cleartext now ineligible for GC for ~5 ms instead of the full header-flush window (#158).
Net forensic guarantee: every export attempt has a `requested` row; every outcome has a paired `delivered`/`failed` row (#158).

## Wave 6 — HIGH-severity plan (queued, conflicts with in-flight)

All HIGHs from the three audits. **Cannot ship in parallel with Wave 5** because every HIGH touches a file in flight on #155-#158. Ship after Wave 5 merges.

| Audit ID | Severity | Site                                                  | One-line fix                                                                                                                             |
| -------- | -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| EXP-H1   | HIGH     | `app.module.ts` throttle setup                        | DB-backed `cache_kv` counter `export:u:<sub>:<yyyymmddHH>` (multi-replica safe)                                                          |
| EXP-H2   | HIGH     | `export-composer.service.ts` decrypt error chain      | `try/catch` around `decryptOwnerPiiBatch`, rethrow as `export_decrypt_failed`                                                            |
| EXP-H3   | HIGH     | `export.controller.ts` response headers               | `reply.header('Vary', 'Cookie, Authorization')` + tighter `Cache-Control`                                                                |
| E-H1     | HIGH     | `pdf-export.service.ts` no client-disconnect handler  | `reply.raw.on('close')` cancels in-flight page; closes context                                                                           |
| E-H2     | HIGH     | `export-composer.service.ts` long-tx pool exhaustion  | Split: project+generator+buildings load in tx; apartments+owners loaded outside the tx where RLS isn't needed (org-id explicit in WHERE) |
| E-H3     | HIGH     | `pdf-export.service.ts:197` bare Error leaks `cwd`    | Sanitised throw — keep candidate list in server log, never in error msg                                                                  |
| E-H4     | HIGH     | `pdf-export.service.ts` chromium.launch failure → 500 | Catch `chromium.launch` errors, surface as `pdf_unavailable` (503) so FE can fall back to xlsx                                           |

## Wave 7 — MEDIUM / LOW backlog (not blocking)

13 medium + low findings across the three reports. Triage them once Wave 6 lands; most are defence-in-depth or product policy questions (M-3 Viewer export = D.17 product call, etc).

## Discipline notes recorded this pass

- **Auditor cadence**: 3 parallel agents (redteam + perf + errors) on the export module in ~5 min produced 30 actionable findings. Same pattern (3 parallel readers, scoped to one module) works as the regression check on any future surface that's been shipped recently. Will apply to the Tenant Portal next.

- **Conflict-avoidance scheduling**: when 5 PRs are in flight against the same module's files, the next wave (any HIGHs against the same files) MUST wait. This is the price of shipping critical fixes in parallel. Don't open the same file twice from two branches.

- **PR-suite post-merge validation**: PR #151 (Wave 4 C-2) merged with green CI but broke `imports.s8.spec.ts` A6 the moment the full suite was re-run on the new main. The action filter assumption (single audit row per `targetTable+targetId`) silently became wrong. Fix: PR #154. Pin: whenever an audit-write count changes per service action, check every spec that queries audit rows by `targetTable` only.
