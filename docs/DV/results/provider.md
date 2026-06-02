# DV results — Interface 2 / Provider (provider_admin) — full coverage (2026-06-02)

> Investigator ran `dv-provider.spec.ts` (Playwright headless, real stack —
> web :3001 / API :3000 / local seed:demo). ONE provider login + Access-Reason
> gate pass, then walked **8 provider surfaces** → screenshots in
> `artifacts/provider-*.png` + structured evidence in
> `artifacts/provider-evidence.json` (per page: doc status, apiCalls+ms,
> consoleErrors, pageErrors, failed4xx5xx, bodyText, form methods). Two extra
> behavioral sub-tests: Access-Reason gate rejection of a too-short reason, and
> the Suspend dialog open-without-confirm on Beta (Beta never suspended).
>
> Credentials are **setup only, not under test** (DV-PLAN §2): `provider@local.dev`
> / `DevPassword123!` / MFA `000000` (dev bypass), Access-Reason `INC-1001`.

## Oracle (seed:demo, derived from the live provider API)

- Tenants total **2** — **Alpha** (users 4 / projects 7 / owners 43 / sig-reqs 30 /
  imports 0), **Beta** (users 1 / projects 1 / owners 1).
- system-health: `pool.app` + `pool.provider` present, all queue counts = 0.
- audit (cross-tenant): rows visible (login, owner.pii_revealed, …).
- Access-Reason enforcement (BE): too-short non-ticket → 400 `reason_required`;
  missing → 400 `reason_required`; `INC-1001` (ticket ref) → 200.

## Health signals (good)

- **0 console errors, 0 page errors, 0 failed 4xx/5xx** across all 8 surfaces.
- **0 GET-fallback forms** — every `<form>` carries `method="post"` (onboard /
  audit-filter / suspend-confirm). CLAUDE.md DoD holds.
- **PII masked at the wire** on tenant detail — names render `•••••••הן`, phones
  `טל' •••••4567`, **national_id never crosses the wire** (D.19 / D.47). Verified
  in the rendered DOM text, not just the API.
- **Runtime: fast.** Every provider API call < **130 ms** (dashboard 101ms,
  alpha-detail 125ms, tenants-list 79ms, system-health 59ms). No N+1 visible.
- **Access-Reason gate works** — blocks the whole `/provider/*` subtree until a
  valid reason; a too-short non-ticket reason keeps submit **disabled** (gate
  mirrors the BE `validateProviderReason`); a ticket ref (`INC-1001`) enables it.
- **Suspend dialog (D.49)** reveals the inline confirm form (optional note +
  destructive confirm) on click; cancel restores the inert state. Beta left
  **ACTIVE** (never confirmed).
- **Cross-tenant isolation correct** — `?orgId=` deep-link filters the audit to
  the chosen tenant; tenant detail "View audit" pre-fills the org filter.

## Findings

| ID        | Sev              | Page(s)             | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                       | Axis           |
| --------- | ---------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- |
| DV-PROV-1 | LOW (UX)         | gate + BE message   | **Access-Reason threshold mismatch in the BE error copy.** The BE 400 message reads "_access_reason must be at least **10** chars … (or use a ticket-id prefix)_", but the FE gate **and** the BE `validateProviderReason` actually require **≥20** substantive chars (3 tokens, 4 distinct). The gate is stricter than its own message claims — a non-ticket 10–19-char reason looks acceptable per the message but is rejected. Stale "10" should read "20". No functional break (gate is stricter), copy only. | curl `access_reason: hello` → 400; `provider-reason.ts` SUBSTANTIVE_MIN_LEN=20 | error-handling |
| DV-PROV-2 | LOW (ergonomics) | every provider page | **9 of 13 sidebar nav items are non-functional stubs** (משתמשים / תוכניות ומחירון / חיובים ומנויים / תמיכה ופניות / תפקידים והרשאות / אינטגרציות / גיבויים ושחזור / צוות EMAPP / הגדרות פלטפורמה). They render `aria-disabled` + lock icon with a "planned" title — intentional per the design (`pc-sidebar.tsx` docblock), non-focusable, never navigated. Logged for completeness: a production operator sees 9 locked items vs 4 live ones. Confirm the partner intends to ship the locked surface in MVP.     | `pc-sidebar.tsx` ITEMS (href:null × 9); dashboard bodyText                     | ergonomics     |
| DV-PROV-3 | LOW (cosmetic)   | system-health       | **Overall status renders "אזהרה" (warning) on a healthy local stack.** With queue all-zero and pools nominal, the page still shows "סטטוס כללי: אזהרה". Likely the `pool.provider` `idle:0` (single connection, in-use during the request) trips a warning heuristic. On local seed this is a false-positive; verify the threshold so prod operators don't see a permanent warning.                                                                                                                               | system-health bodyText "סטטוס כללי: אזהרה"; API `pool.provider.idle=0`         | error-handling |

> No HIGH/MED findings. The provider interface is the cleanest of the four so
> far — masked PII, audited reads, fast queries, working gate + suspend flow.

## Coverage (provider column — INVENTORY Interface 2)

**Captured (8 surfaces / 6 inventory rows):**

| INVENTORY row             | Surface(s) walked                                                 | Status |
| ------------------------- | ----------------------------------------------------------------- | ------ |
| Access-Reason gate (D.37) | gate block + reject-short + accept-ticket (sub-test)              | 🟩     |
| Tenants list              | `/provider/tenants` (Alpha + Beta both shown)                     | 🟩     |
| Tenant detail             | `/provider/tenants/{alpha}` + `{beta}` (counts + masked PII)      | 🟩     |
| Suspend / reactivate      | suspend dialog opened on Beta, verified, **not confirmed** (D.49) | 🟩     |
| Onboarding                | `/provider/onboard` (form present, method=post)                   | 🟩     |
| Audit (cross-tenant)      | `/provider/audit` + `?orgId=` deep-link filter                    | 🟩     |
| System-health             | `/provider/system-health` (live queue/pool/R2 metrics)            | 🟩     |

**Behavioral (DV-PLAN §11) confirmed:**

- Audit page reflects provider activity (login + owner.pii_revealed rows visible
  cross-tenant). The L4 lifecycle's "every provider action → provider_audit_log
  row" is supported by the audit-first `withProvider` BE path; full suspend→row
  confirmation deferred because we deliberately do **not** confirm the suspend.

**Gaps (not exercised — by design or deferred):**

- **Suspend → reactivate round-trip + audit-row assertion** (L4). Deliberately
  NOT run end-to-end: confirming a suspend mutates Beta's state. Left to the
  adversarial / lifecycle pass under a reseed guard (DV-PLAN §8). The dialog
  _open_ path is covered; the _confirm_ path is intentionally untouched.
- **Onboard create** (POST org + first-manager invite) — form rendered + verified
  `method=post`, but a real submit would create a new org. Deferred to the
  mutate-allowed lifecycle pass.
- **Gate via real form submit** in the walk test uses sessionStorage seeding for
  the per-page re-mount; the _real_ gate-form submit is exercised in the
  reject-short sub-test (fill → disabled → valid → enabled).
- Visual PNG review (layout/jank/RTL) — pending selective review (NOT all-at-once,
  per the crash-avoidance rule).
