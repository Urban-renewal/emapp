# EMAPP — Test Coverage Matrix (13 entities × 7 angles)

> Purpose: turn "infinite possibilities" into a **closed, reviewable grid**.
> You do not test every input — you test every _contract_. 13 entities × 7
> angles ≈ 91 cells. Each cell names the test(s) that prove it.
>
> Last live run: conformance **15 files / 167 pass / 1 skip**;
> unit **policy.spec 164/164**; `@emapp/db` suite CI-verified green.

## The 7 angles (the same questions asked of every entity)

1. **Happy** — the smallest correct create/read works, `{data}` shaped.
2. **Validation** — missing/bad type / unknown field → `400 validation_error` _before_ DB (`.strict()` fail-closed).
3. **Authz deny-matrix** — every role that must be refused gets `403` (D.17).
4. **Tenant isolation (no-oracle)** — another org's resource → `404`, never `403`/empty-`200`.
5. **Error envelope** — every failure is D.16 `{error:{code}}` with a stable code; no PII / pg detail leak.
6. **Lifecycle** — soft-archive / end / revoke / state transition behaves and is irreversible-correct.
7. **Edge / adversarial** — tampered cursor, duplicate→409, concurrency race, oversized/injection, PII non-leak.

Legend: ✅ = covered by the named test ID(s). **⊕** = authz deny enforced
centrally by `policy.spec.ts` (164 cases, all 13 resources × roles × actions)
**and proven at RUNTIME** in `members.contract.spec.ts` (Viewer→403 on every
write, Agent→404 no-oracle). Angles 5 & 7 are additionally amplified
system-wide by `phase3-hardening.contract.spec.ts` (H1–H18).

## The grid

| Entity              | 1 Happy             | 2 Validation     | 3 Authz                | 4 Tenant-iso       | 5 Envelope | 6 Lifecycle                   | 7 Edge                          |
| ------------------- | ------------------- | ---------------- | ---------------------- | ------------------ | ---------- | ----------------------------- | ------------------------------- |
| projects            | PR2 ✅              | PR3 ✅           | ⊕                      | PR7 ✅             | PR12 ✅    | PR9 archive ✅                | PR10/PR11 ✅                    |
| buildings           | BR2 ✅              | BR3 ✅           | ⊕                      | BR4/BR7 ✅         | ✅         | BR9 archive ✅                | BR10/BR11 ✅                    |
| apartments          | AR2 ✅              | AR3 ✅           | ⊕                      | AR4/AR7 ✅         | ✅         | AR8 status / AR9 ✅           | AR10/AR11 ✅                    |
| owners              | OWN2 ✅             | OWN3 ✅          | ⊕                      | OWN8 ✅            | ✅         | OWN12 archive ✅              | OWN13 + OWN4(409) + PII(H12) ✅ |
| ownerships          | OWS2 ✅             | OWS3/OWS4 ✅     | ⊕                      | OWS8 ✅            | ✅         | OWS5/OWS6 set-replace ✅      | OWS10 + OWS7(404) ✅            |
| contractors         | CN2 ✅              | CN3 ✅           | ⊕                      | CN7 ✅             | ✅         | CN9 archive ✅                | CN10 + CN4(409) ✅              |
| shares              | SH2 ✅              | SH3 ✅           | ⊕                      | SH5 ✅             | ✅         | SH9 revoke ✅                 | SH10 + SH6(409) + SH4 ✅        |
| notifications       | NT2 ✅              | NT3 ✅           | self-RLS               | NT2 own-only ✅    | ✅         | NT4 mark-read ✅              | NT5 ✅                          |
| tasks               | TK2 ✅              | TK3 ✅           | ⊕                      | TK6 ✅             | ✅         | TK7 complete / TK9 ✅         | TK10 + TK8(409) ✅              |
| audit               | AU2 ✅              | n/a (read-only)  | ⊕                      | AU5 ✅             | ✅         | AU3 append-only (no write) ✅ | AU4 ✅                          |
| notes               | NO2 ✅              | NO3 ✅           | ⊕                      | NO4/NO7 ✅         | ✅         | NO9 archive ✅                | NO10 ✅                         |
| project-assignments | PA2 ✅              | PA3 ✅           | ⊕                      | PA7 ✅             | ✅         | PA8 unassign ✅               | PA9 + PA4(409) ✅               |
| members             | ME invite/accept ✅ | ME validation ✅ | **ME1–ME7 RUNTIME** ✅ | ME cross-tenant ✅ | ✅         | invite/accept single-use ✅   | self / last-manager guards ✅   |

## System-wide amplifiers (cross-cutting, not per-entity)

| Concern                             | Where proven                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D.17 full deny matrix (static)      | `policy.spec.ts` — 164 cases, 13×roles×actions, independent EXPECTED table                                                                                           |
| D.17 deny matrix (runtime/HTTP)     | `members.contract.spec.ts` ME5/ME6/ME7                                                                                                                               |
| Error envelope on every route       | hardening H3 (samples all domain routes)                                                                                                                             |
| Never 500 on adversarial input      | H4 (malformed JSON), H5 (content-type), H6 (oversized), H7 (array DoS), H8 (injection/XSS/unicode/NUL), H9 (numeric edges), H10 (verb confusion), H11 (cursor abuse) |
| ISO data-security (PII non-leak)    | H12 (owner create/list/search), H13 (audit no diff/ip/ua)                                                                                                            |
| Multi-tenant no-oracle (systematic) | H14 — org-B sees every org-A by-id resource exactly as a random uuid                                                                                                 |
| Concurrency / race safety           | H15 (dup owner create ≤1), H18 (idempotency replay)                                                                                                                  |
| Hot-path latency budget             | H16 (create+list median guard)                                                                                                                                       |
| Keyset pagination integrity         | H17 (full traversal, zero loss/dup, ordered)                                                                                                                         |
| Encryption / RLS at the DB layer    | `@emapp/db` `encryption.spec.ts`, `multi-org.spec.ts`, `t1-5-rls-isolation.spec.ts`, `t1-4-check-triggers.spec.ts`                                                   |

## How to extend (the method, so it never feels like "building from air")

For any **new** entity, the backlog is not "imagine every input" — it is
exactly **7 rows**: copy an existing `*.contract.spec.ts`, fill angles 1,2,4,5,6,7;
angle 3 is free (add the resource to `policy.ts` → `policy.spec.ts` covers it,
and `members.contract` proves it at runtime). A new entity with all 7 cells
filled is, by construction, as covered as every entity already shipped.

Any blank cell in this grid is the precise, finite to-do list. There are
currently none for the 13 Phase-3 entities.
