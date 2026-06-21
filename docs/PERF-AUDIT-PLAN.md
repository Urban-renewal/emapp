# EMAPP Full Audit — Execution Plan & Completeness Gate

> Goal: cover **every role × every page × every interaction**, measure run-time
> AND verify each one SUCCEEDS (catch silent failures like add-apartment).
> "Done" is not a feeling — it is the **completeness gate** below evaluating true.

## The completeness gate (how I'll KNOW nothing was missed)

The master list is `docs/PERF-AUDIT-INVENTORY.md` (105 actions). The harness
writes one result row per `{role, action}` it exercises. At the end:

```
COMPLETENESS = every applicable (role, inventory-action) pair has a result row
               with: timing + PASS/FAIL + (on FAIL) the error.
```

The harness prints `COVERED x / EXPECTED y` and lists any **MISSING** pairs.
The audit is only "done" when MISSING = 0. No partial passes, no "3 routes".

## Coverage matrix — roles × surfaces

| Surface / capability | Manager | Agent | Viewer | Provider | Tenant | Contractor |
| -------------------- | :-----: | :---: | :----: | :------: | :----: | :--------: |
| Login + load session | ✅ | ✅ | ✅ | ✅ (MFA) | ✅ (OTP) | ✅ (share link) |
| Dashboard home | ✅ | ✅ | ✅ | ✅ | — | — |
| All list pages (projects…contractors) | ✅ | scoped | read | — | — | — |
| All detail pages | ✅ | scoped | read | — | — | — |
| **Create project** | ✅ | ✅ | ✗(403) | — | — | — |
| **Create building** | ✅ | ✅ | ✗ | — | — | — |
| **Create apartment** ⚠(owner reports FAIL) | ✅ | ✅ | ✗ | — | — | — |
| **Create owner** | ✅ | ✗ | ✗ | — | — | — |
| **Reveal PII** | ✅ | cap | ✗ | — | — | — |
| **Send signature request** ⚠(slow) | ✅ | ✅ | ✗ | — | — | — |
| **Import file (xlsx)** ⚠(slow) | ✅ | ✅ | ✗ | — | — | — |
| **Upload document** | ✅ | ✗ | ✗ | — | — | — |
| **Settings save** ⚠(slow) | ✅ | — | — | — | — | — |
| Members / IAM / contractors | ✅ | — | — | — | — | — |
| Messaging (send) | ✅ | ✅ | ✅ | — | — | — |
| Provider tenants/audit/health | — | — | — | ✅ | — | — |
| Public sign flow | — | — | — | — | ✅ | — |
| Contractor portal (read+download) | — | — | — | — | — | ✅ |

## Execution phases

- **P-A — Reproduce the owner's failures FIRST** (highest value): add-apartment
  fail, then send-signature / import / settings slowness. Real browser, diagnose
  each (network status + error body + console). These are bugs, not just timing.
- **P-B — Comprehensive measurement harness** (`apps/web/perf-audit/run.mjs`,
  extended): multi-role login + every list/detail page-load + every interaction
  (create flows, send, import, settings) → timing + PASS/FAIL + waterfall.
- **P-C — Completeness gate**: assert MISSING = 0 against the inventory; list any gap.
- **P-D — Per-action optimization**: one-by-one, the >1s real (non-dev-mode)
  costs + the FAILURES, security-preserving, green-gated, re-measured.

## Method (unchanged principles)
Chrome (real) → web :3001 → API :3000 on `DB_TARGET=local`. Warm = median of N
(real number); cold = labeled dev-compile artifact. Distinguish dev-mode overhead
from real DB/API cost. Honest: a FAIL is reported as a FAIL with its error.
