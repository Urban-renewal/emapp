# DV — Interface 4 (Contractor — share-link, read-only) · results

> Source: `dv/contractor` @ branch head · driven 2026-06-02 against local
> seed:demo (app :3001 / api :3000). Spec: `apps/web/e2e/audit/dv-contractor.spec.ts`
> (PASSING). Evidence rollup: `artifacts/contractor-evidence.json` ·
> screenshot: `artifacts/contractor-share-view.png`.

## Entry / precondition (inter-role)

The contractor has no login. A **manager** (`manager@alpha.dev`) mints a
share on the Pilot project (`1ace1c99…`, "Tama 38/2 — Pilot",
`gathering_signatures`) for contractor _אדריכלי לוין_ and mints a share-access
token via `POST /api/v1/shares/{id}/link`. Entry =
`/he/contractor/share/{token}` (token = sole credential, Bearer-forwarded to
`ContractorAuthGuard`, audience `emapp-share`). The spec mints this **at
runtime** — no hardcoded token.

## Oracle (seed:demo, Pilot)

| Surface   | Expected                                                      | Actual | Status |
| --------- | ------------------------------------------------------------- | ------ | ------ |
| Project   | name "…Pilot", status `gathering_signatures`, type `tama38_2` | ✓      | 🟩     |
| Buildings | 2 (בן יהודה 25, הרצל 10), 4 apartments total, structural cols | ✓      | 🟩     |
| Progress  | aggregate `signed=2 pending=2 total=4` (50%), no identities   | ✓      | 🟩     |
| Documents | 2 project-level PDFs (blueprint + regulation), no per-owner   | ✓      | 🟩     |

## Verdicts

### PII boundary — **CLEAN (CRITICAL gate PASSED)** 🟩

Scanned every `/contractor/*` response body **and** the rendered read-view DOM
for owner-PII needles (`national_id`/`nationalId`, `phone`, owner names like
`דנה כהן`, `ownership`). **Zero hits.** The boundary is _structural_, not a
runtime flag: the contractor service queries no owners/ownerships table — owner
PII is unrepresentable in this tier (confirmed in code:
`contractor-read.service.ts` selects structural apartment columns only, no
ownership join).

Cross-tier confirmation: the share token presented to the org endpoint
`GET /api/v1/owners` → **401** (wrong audience). A contractor cannot pivot to
org PII even by guessing the URL.

### IDOR (download) — **SAFE** 🟩

| Probe                                                             | Result              | Expected                                   |
| ----------------------------------------------------------------- | ------------------- | ------------------------------------------ |
| Legit project-level doc → download                                | 200 (presigned URL) | 200                                        |
| **Apartment-linked doc in the SAME project** (resident agreement) | **404**             | 404 — per-owner agreements excluded (D.46) |
| **Another project's** project-level doc                           | **404**             | 404                                        |
| Random uuid                                                       | **404**             | 404                                        |

No out-of-scope id ever minted a URL. The service IDOR-locks on
`project_id = share.project AND apartment_id IS NULL AND archived_at IS NULL`.

### Auth / revocation — **SAFE** 🟩

| Probe                                      | Result              | Expected        |
| ------------------------------------------ | ------------------- | --------------- |
| No token                                   | 401 `missing_token` | 401             |
| Garbage token                              | 401 `invalid_token` | 401             |
| Throwaway share **before** revoke          | 200                 | 200             |
| Same share **after** `DELETE /shares/{id}` | **401**             | 401 — immediate |

Revocation is immediate (the guard re-reads `shares.revoked_at` each request);
the 30-day token TTL never outlives a manager revoke.

### Runtime / console — **CLEAN** 🟩

Read-view doc status 200, networkidle settled, **0 console errors, 0 page
errors**. RTL Hebrew renders correctly.

---

## Findings

### DV-CON-1 — Progress is raw counts only; no consent-vs-legal-threshold / per-building / velocity · MEDIUM · ergonomics / missing-feature

**Axis:** ergonomics / missing-feature.
**Where:** `GET /api/v1/contractor/progress` →
`apps/web/src/app/[locale]/(contractor)/contractor/share/[token]/page.tsx`.

**Observed:** the endpoint returns `{ signaturesSigned, signaturesPending,
signaturesTotal }` and the UI renders "2 מתוך 4 חתימות נאספו (50%)" — a raw
percentage of signed/total.

**Gap (the urban-renewal-relevant number is missing):** תמ"א 38/2 &
פינוי-בינוי decisions turn on **% signed vs the statutory majority** (the legal
threshold), not raw count. A contractor evaluating feasibility needs:

1. **consent-vs-threshold** — the gap to the legal majority (the go/no-go number);
2. **per-building breakdown** — each building shows only its apartment _count_
   ("2 דירות"), never its signing progress, yet the legal majority is assessed
   per-building in many renewal schemes;
3. **velocity** — signing rate over time (is the project converging?).

This is an _additive_ improvement within the existing read-only design — not a
boundary violation. No PII is implied (all three are aggregates).

**Evidence:** `artifacts/contractor-evidence.json` →
`findings[0]` + `missingFeature: { hasThreshold:false, hasPerBuilding:false }`;
`artifacts/contractor-share-view.png`.

---

## No other findings

PII boundary clean · IDOR safe · auth/revocation correct · 0 console errors.
The only finding is the missing-feature DV-CON-1 above (MEDIUM).
