# EMAPP — V12 Decisions (Stabilize + Complete phase)

> Locked decisions for the post-V11 phase. Continues the D.NN numbering from
> DECISIONS.html. These are LAW for the V12 plan — agents implement, don't
> re-litigate. Each has rationale so a future reader knows _why_.

---

## D.42 — User provisioning & onboarding model

**Decision:** provisioning mechanism is matched to the user population; there is
no single "create user" path and **no open/shared-secret signup**.

| Who creates whom                     | Mechanism                                                                                                     | Status     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------- |
| Provider Admin → Org + first Manager | Provider-initiated: create org + send the first manager an **invite-token email** (manager sets own password) | build (D1) |
| Org Manager → Agent / Viewer         | **invite-token email** (`invite-email.ts`), invitee sets own password                                         | built      |
| Org Manager → Contractor             | **share-link** with scoped perms (see D.43)                                                                   | partial    |
| Resident (דייר)                      | **SMS OTP**, no account, identified by owner record                                                           | built      |

**Rationale:** per-user invite tokens are single-use, expiring, scoped, and
let the invitee set their own credential (ISO A.9.2) — strictly better than a
shared registration key (forwardable, leakable). OTP serves the periphery
audience with zero account management. Consistent with D.21 "no signup".

---

## D.43 — Tenant permission model (Agent matrix + Contractor scope)

**Decision:** the tenant **Manager controls permissions** for both Agents and
Contractors, via a **curated capability matrix** (not atomic per-field perms,
not fixed roles).

### Field Agent — manager-toggled capability matrix (scoped to assigned projects)

Base (always on once assigned): **view assigned project data**. Manager toggles
per agent:

| Capability                                          | Default                           |
| --------------------------------------------------- | --------------------------------- |
| Edit project data (buildings / apartments / owners) | off                               |
| Manage documents (upload / download)                | off                               |
| Manage signatures (create requests)                 | off                               |
| Manage tasks / calendar                             | off                               |
| Run imports                                         | off                               |
| View owners                                         | on (PII always masked — see D.44) |

(Curated bundles, not 15 atomic toggles — extensible later. Enforced
server-side per D.17, not just UI-hidden.)

### Contractor — per-share resource scope (read + download, no write)

A share grants the manager-chosen subset, **view + download** (anything the
contractor can see, he can download). Pure consumption — no create/edit/delete.

| Resource in share     | Default          | Notes                                                                                                      |
| --------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Project (shared only) | on               | name/type/status/timeline                                                                                  |
| Buildings + sections  | on               | incl. gush/helka (construction planning)                                                                   |
| Apartments            | on               | structural only (count/type/area/floor — no owner link)                                                    |
| Signature progress    | on               | **AGGREGATE % only** ("62% signed, 14 left") — never who/individual                                        |
| Documents             | manager-selected | view + **download**; only the docs the manager shares (regulation/plans/permits, NOT per-owner agreements) |
| Owners / PII          | off              | never — not even masked, by default                                                                        |
| Tasks                 | off              | only if explicitly invited                                                                                 |

**Download enforcement (security — IDOR):** the presigned-download endpoint must
verify the requested document is within the contractor's share before minting a
URL. A contractor requesting a doc-id outside his share → **404 (no-oracle)**.
Download is scoped, not "any id the share-holder asks for".

**Extensibility (locked intent):** today the contractor is read+download only.
The capability set is stored as JSONB (D.17) so **future permission expansion =
enabling more capabilities** (e.g. upload a quote, comment) **without schema
change or re-architecture**. The model is built capability-driven from day one
precisely so this stays cheap.

**Rationale:** the brief required "variable permissions managed by the tenant
manager" (agent) and configurable contractor access; D.17 already models
contractor JSONB perms. Curated capabilities (vs atomic) keep it buildable and
comprehensible while honouring manager control. **Cost note:** this is more
than the fixed-role default — adds the permission-matrix UI + server
enforcement + tests (expands Track D, see plan impact).

---

## D.44 — Resident sees masked PII (resolves SEC-1)

**Decision:** `/portal/me` masks the resident's own `national_id` and `phone`
(`•••••••53`), consistent with the org-side D.19 masking. No cleartext PII on
the wire, anywhere.

**Rationale:** consistency + minimal PII exposure + cleanest ISO posture. The
small UX cost (resident can't read their full ID back) is acceptable; if a
"reveal" is ever needed it becomes an explicit, audited action — not a default.

---

## D.45 — Provider console on a separate subdomain

**Decision:** the Provider (product-admin) console lives on **`admin.emapp.io`**
— a separate Cloudflare Pages app — not a path on the customer app.

**Implications (locked):**

- `provider_access_token` cookie scoped to the admin subdomain only; never
  shared with the customer app's cookie scope.
- Separate Pages deployment + route handler clone for the `/api/v1/provider/*`
  proxy.
- Provider login + MFA (D.21) gate the whole subdomain.

**Rationale:** full cookie/blast-radius isolation between the SaaS control plane
and customer tenants — a Provider token can never act on the customer app and
vice-versa. Worth the second deployment. (Resolves the long-standing H1
topology open item.)

---

## Technical defaults (applied unless overridden)

| ID  | Decision                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------- |
| T4  | No shared-secret signup (folded into D.42)                                                           |
| T5  | ISO target = full Annex A baseline until the auditor narrows scope                                   |
| T6  | Hosting: colocate app + Neon in EU (perf — kills the 138ms round-trip)                               |
| T7  | Loading skeletons allowed (polish, not a design change)                                              |
| T8  | Domain scheme: `app.` (customer) / `admin.` (provider) / `notifications.` (email) on the chosen root |

## Procurement-pending (design decided; buy/obtain when ready)

| Item         | Design decision                                                    | Pending                 |
| ------------ | ------------------------------------------------------------------ | ----------------------- |
| SMS provider | behind `ISMSProvider`; `noop` in dev; recommend **Inforu** for OTP | open account            |
| ISO scope    | baseline Annex A (T5)                                              | obtain SoA from auditor |
| Root domain  | scheme locked (T8)                                                 | purchase root domain    |

---

## Plan impact (these decisions changed the work)

- **D.43** adds a **permission-model slice** to Track D (matrix UI + server
  enforcement + tests) — bigger than the fixed-role default.
- **D.45** adds a **second FE app** (admin subdomain) to hosting + a cookie-
  scope slice.
- **D.44** shrinks SEC-1 to a small masking fix.
- D.42 confirms the existing invite/OTP/share primitives — mostly built.

`MASTER-PLAN-V12.md` Track D + `SETUP-EXTERNAL-SERVICES.md` (§8 Pages) to be
updated to reflect D.43 + D.45.
