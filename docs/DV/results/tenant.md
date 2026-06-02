# DV results — Interface 3 / Resident (tenant portal) — full coverage (2026-06-02)

> Investigator ran `dv-tenant.spec.ts` (Playwright headless, real stack —
> web :3001 / API :3000 / local seed:demo). ONE OTP login (phone `0501234567`,
> dev code `000000`), then walked the single-page resident portal `/he/portal`
> (+ a reload) → screenshots in `artifacts/tenant-*.png` + structured evidence in
> `artifacts/tenant-evidence.json`. Per page: doc status, apiCalls+ms, the FULL
> `/api/v1/portal/*` response bodies, consoleErrors, pageErrors, failed4xx/5xx,
> bodyText, form methods, and the **leak-scan hits** (the headline check).
>
> Three extra behavioral sub-tests: (1) the scope leak-scan over DOM + every wire
> body, (2) cross-tier isolation (the tenant cookie must NOT read org `/projects`
> or render org data), (3) logout revokes the tenant session.
>
> Credentials are **setup only, not under test** (DV-PLAN §2).

## Oracle (seed:demo, derived from the live portal API with the tenant cookie)

The resident is **דנה כהן** (owner `86ea1064-…`, org Alpha `f4c183e2-…`):

| Endpoint             | Body (own-data-only)                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/portal/me`         | name `דנה כהן`, **`nationalIdMasked:"•••••••10"`**, **`phoneMasked:"•••••4567"`**, email `dana@example.dev` (own) |
| `/portal/apartment`  | **2 own** apartments (pct 100 + 60), project `Tama 38/2 — Pilot`, building `הרצל 10` תל אביב                      |
| `/portal/documents`  | **2 own** agreement PDFs (`הסכם דייר — דירה 1/2.pdf`)                                                             |
| `/portal/signatures` | **2 own** (1 `pending` דירה 1, 1 `signed` דירה 2)                                                                 |
| `/portal/progress`   | **AGGREGATE only** — `signaturesSigned:2 · signaturesPending:2 · signaturesTotal:4`, project `Tama 38/2`          |

## SCOPE VERDICT — **OWN-DATA-ONLY: CONFIRMED** ✅

The headline DV-PLAN resident SCOPE assertion **holds**. Across the rendered DOM
text **and** every `/api/v1/portal/*` response body:

- **No other resident's name** appears (negative oracle: `ישראל ישראלי`,
  `אברהם לוי`, `שרה מזרחי`, `יוסי כהן` — none present).
- **No cleartext `national_id`** (9-digit run) crosses the wire or renders.
  Own national_id is **masked** at the wire as `•••••••10` (D.47).
- **No unmasked phone** (`05X-XXXXXXX`) anywhere. Own phone is **masked** at the
  wire as `•••••4567` (D.47).
- **No raw cleartext PII JSON key** (`national_id` / `nationalId` / `phone`) in
  the `/portal/me` wire body — the wire exposes ONLY the `*Masked` variants.
- **Project progress is a true AGGREGATE** — `signed/pending/total` are COUNTS
  with NO per-resident breakdown. The `total:4` includes neighbours' signatures
  but discloses zero identities. Correct per the SCOPE rule.

The masking is applied **server-side at the wire** (not just hidden in the DOM),
so even a raw `fetch('/api/v1/portal/me')` from the resident's browser yields
masked PII — the strongest form of the control.

## Health signals (good)

- **0 console errors, 0 page errors, 0 failed 4xx/5xx** on the portal.
- **0 GET-fallback forms** — the portal page itself has no `<form>`; the login
  forms (out of scope) carry `method="post"` (verified in login page source).
- **All 5 portal GETs fire and 200** on load (`me · apartment · documents ·
signatures · progress`).
- **Cross-tier isolation holds** — a `tenant_access_token` (audience
  `emapp-tenant`) does NOT read org `/api/v1/projects` (not 200); the org route
  rendered no foreign owner data to the tenant.
- **Logout** (`POST /portal/logout`) returns 204 and revokes the session — a
  subsequent `/portal/me` is no longer 200.

## Findings

| ID       | Sev | Page(s) | Finding                                                                                                                                                                                      | Evidence                           | Axis     |
| -------- | --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------- |
| _(none)_ | —   | —       | No HIGH/CRITICAL scope leak. No MED/LOW behavioral break observed in the portal. The resident interface is correctly scoped: own-data-only, server-side-masked PII, aggregate-only progress. | `tenant-evidence.json` (leaks: []) | security |

> **No findings.** The resident portal is the tightest-scoped of the four
> interfaces: every PII field masked at the wire, zero foreign-resident data,
> progress disclosed only as aggregate counts. The CRITICAL DV-TEN assertion
> (no other resident's data / no cleartext national_id) is **CLEAN**.

## Coverage (resident column — INVENTORY Interface 3)

| INVENTORY row                | Surface(s) walked                                            | Status |
| ---------------------------- | ------------------------------------------------------------ | ------ |
| Project progress (aggregate) | portal `progress` section — counts only, no identities       | 🟩     |
| My signatures                | portal `signatures` section — 2 own (pending + signed)       | 🟩     |
| Documents sent to me         | portal `documents` section — 2 own agreement PDFs            | 🟩     |
| My data (PII masked, D.47)   | portal `identity` section — `•••••••10` / `•••••4567` masked | 🟩     |

## Gaps / honest residual (DV-PLAN §7.4)

- **Sign action not exercised end-to-end here.** The portal is read-only (D.40);
  the actual signing happens via an out-of-band SMS link (D.12 — token never
  re-emitted on the wire), so the portal shows signature _status_ only. The full
  sign cycle is covered by lifecycle **L1** (manager → resident sign → sync),
  not by this single-interface pass.
- **Empty-state not reached on this resident** (דנה has apartments, docs, and
  signatures). The portal's empty-state copy (`apartment.empty` /
  `documents.empty` / `signatures.empty` / `progress.empty`) renders only for a
  resident with no data — exercising it needs a second seeded resident with an
  empty profile. Logged as a state-matrix residual, not disguised as covered.
- **Per-doc download** is intentionally absent (portal returns metadata only);
  not a gap, a documented D.40 scope delta.
