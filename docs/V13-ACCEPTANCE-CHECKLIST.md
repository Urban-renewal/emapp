# V13 ACCEPTANCE CHECKLIST — "everything, including everything" (owner-mandated)

> **The "done" bar (owner, 2026-06-21):** NOT done until EVERY interface + EVERY process, for
> EVERY role, is verified in the owner's real Chrome — **loads · fast runtime · NO background/console
> errors · NO failed network calls · correct behavior · role-correct access/PII-masking.** The owner
> will log in and must not find a single broken/incorrect interface or process. Tested by ME (real
> Chrome) + dispatched audit AGENTS — coverage tracked here so nothing is missed.

## The 6 quality axes (every interface must pass ALL)
1. **Loads** — renders, no error boundary, no infinite spinner.
2. **No console errors** — clean console (only benign dev notices); no React/hydration/runtime errors.
3. **No failed network** — every `/api/v1/*` call 2xx (or intended 4xx); no 5xx, no unexpected 401/403.
4. **Fast runtime** — warm interaction < ~300ms; no obvious jank; (dev first-compile excepted).
5. **Correct behavior** — the interface does what it should; actions work; one-click flows complete.
6. **Role-correct** — access gated right per role; PII masked where it must be; no cross-tenant leak.

## Test methods (coverage strategy — work smart, parallel)
- **E2E suite** (`apps/web/e2e/*`) — the existing Playwright flows (j8/j9/j11/j15/j18/j20/j21,
  critical-path, sign-flow, …) cover many role-flows. Run FULL + green = a large swath covered.
- **Agent route-audit fleet** — agents drive each route-group on the live dev server, capturing
  console + network + runtime per route, as the relevant role. Parallel, headless. They REPORT
  per-route pass/fail on the 6 axes.
- **My real-Chrome walks** — the owner's Chrome, for: the new/changed surfaces, the most-visible
  surfaces, every role's entry, and anything an agent flags. This is the authoritative layer.
- **BE health** — full api + db suites green on CI; no 5xx; perf budgets.

## COVERAGE MATRIX (status: ☐ todo · 🔄 in-progress · ✅ pass · ⚠️ fix-needed)

### Auth / public (no session) — roles: anonymous
| # | interface | method | status |
|---|---|---|---|
| A1 | `/login` (org) | my-Chrome + e2e | ☐ |
| A2 | `/signup` (atomic org bootstrap) | my-Chrome + e2e | ☐ |
| A3 | `/forgot-password` + `/reset-password` | agent + e2e | ☐ |
| A4 | `/accept-invite/[token]` | agent | ☐ |
| A5 | `/provider/login` (email+pw+TOTP) | my-Chrome | ☐ |
| A6 | `/tenant/login` (phone+OTP) | my-Chrome (0501234567/alpha-dev/000000) | ☐ |
| A7 | `/sign/[token]` (public signer) | my-Chrome + e2e | ☐ |

### Org tier — Manager (full) · Agent (assigned only) · Viewer (read-only). Verify all 3 where relevant.
| # | interface | roles | method | status |
|---|---|---|---|---|
| M1 | `/` home (FLEET situation-picture — new) | mgr·agent·viewer | my-Chrome (each) | ☐ |
| M2 | `/projects` (list — server-search after NS6) | mgr·agent·viewer | my-Chrome + agent | ☐ |
| M3 | `/projects/[id]` (detail + tabs + board + leverage) | mgr·agent·viewer | my-Chrome | ☐ |
| M4 | `/projects/new` (wizard) | mgr | my-Chrome | ☐ |
| M5 | `/projects/[id]/assignments` | mgr | agent | ☐ |
| M6 | `/projects/[id]/buildings` (+`/new`) | mgr | agent | ☐ |
| M7 | `/projects/[id]/shares` (contractor + new external_share) | mgr | my-Chrome | ☐ |
| M8 | `/owners` (search-first) + `/owners/[id]` (PII reveal) + `/owners/new` | mgr·agent·viewer | my-Chrome + agent | ☐ |
| M9 | `/apartments` + `/[id]` + `/[id]/ownerships` | mgr·agent | agent | ☐ |
| M10 | `/buildings` + `/[id]` + `/[id]/apartments` (+`/new`) | mgr·agent | agent | ☐ |
| M11 | `/documents` (search-first) + `/[id]` + `/new` (incl. נסח type + checklist) | mgr·agent·viewer | my-Chrome | ☐ |
| M12 | `/signature-requests` + `/[id]` + `/new` | mgr·agent | my-Chrome + e2e | ☐ |
| M13 | `/tasks` + `/[id]` + `/new` | mgr·agent | agent | ☐ |
| M14 | `/notes` + `/[id]` + `/new` | mgr·agent | agent | ☐ |
| M15 | `/members` + `/[userId]` (overrides) + `/new` | mgr | agent | ☐ |
| M16 | `/contractors` + `/[id]` + `/new` | mgr | agent | ☐ |
| M17 | `/imports` + `/[id]` (+`/errors`,`/mapping`) + `/new` | mgr | agent | ☐ |
| M18 | `/audit` | mgr | agent | ☐ |
| M19 | `/messages` (team messaging) | mgr·agent | agent | ☐ |
| M20 | `/notifications` (deep-links) | mgr·agent·viewer | agent | ☐ |
| M21 | `/settings` + `/settings/roles` | mgr | my-Chrome | ☐ |

### Contractor tier (share token, no account) — sensitive EXCLUDED
| # | interface | method | status |
|---|---|---|---|
| C1 | `/contractor/share` (overview/docs/signatures per JSONB perms; NO PII; sensitive excluded; new external_share path) | my-Chrome (share token) | ☐ |

### Tenant tier (SMS OTP, own record)
| # | interface | method | status |
|---|---|---|---|
| T1 | `/portal` (own apartment/docs/signatures/progress) | my-Chrome (OTP session) | ☐ |

### Provider tier (cross-tenant, MFA, audited)
| # | interface | method | status |
|---|---|---|---|
| P1 | `/provider` (home) + `/provider/tenants` (+`/[id]`,`/users`) | my-Chrome (seed provider-admin) | ☐ |
| P2 | `/provider/audit` (+`/audit/self`) · `/backups` · `/onboard` · `/system-health` | agent | ☐ |

### Processes (cross-interface flows — end-to-end)
| # | process | method | status |
|---|---|---|---|
| F1 | signup → bootstrap org → land on home | my-Chrome | ☐ |
| F2 | create project → add building/apartment → add owners/ownerships → consent recompute | my-Chrome | ☐ |
| F3 | create signature-request → public sign `/sign/:token` → consent % moves → board updates | my-Chrome + e2e | ☐ |
| F4 | upload document (נסח → sensitive → OTP step-up; checklist ticks) → download | my-Chrome | ☐ |
| F5 | share to external party (preset → narrow → OTP) → recipient access + watermark | my-Chrome | ☐ |
| F6 | leverage card → one-tap reminder (chase) → kill-switch honored | my-Chrome | ☐ |
| F7 | import owners (xlsx) → mapping → materialize → stats fresh | agent | ☐ |
| F8 | role gating: agent sees only assigned; viewer read-only; PII masked per cap | my-Chrome (each) | ☐ |

## RUNTIME / ERROR / PERF global checks
- ☐ Full e2e suite green (existing flows, all roles).
- ☐ Full api + db suites green on CI (no 5xx, RLS isolation, masked PII).
- ☐ Per-interface console scan: zero React/hydration/runtime errors across the matrix.
- ☐ Per-interface network scan: zero 5xx / unexpected 401-403; all intended calls 2xx.
- ☐ Perf: home + board + lists warm < ~300ms; pulse/search/leverage sub-second at seeded-500 (NS8).
- ☐ No `text-muted` invisible-text regressions on any walked surface (contrast ≥ AA where light-bg).

## SIGN-OFF
- Not "done" until every row above is ✅ and every fix verified. Deferred items (per MASTER-PLAN-V13)
  are documented complete-next-slices, NOT broken interfaces — they must not appear broken to the owner.
