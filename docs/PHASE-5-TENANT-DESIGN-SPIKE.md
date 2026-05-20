# Tenant-authenticated data path — RLS design spike (POST-Phase-5)

> **Status (re-scoped 2026-05-20, same day):** this spike was originally
> filed as a "pre-Phase-5 obligation" by audit-pass V #6. **That framing
> was wrong** and is corrected here: Phase 5 per docs/03 §9 is the
> **public-link JWT signing flow** (`/sign/[token]`, 7-day single-use
> token, NO Tenant authentication required for the signing endpoint).
> Phase 5 does NOT introduce any Tenant-authenticated data endpoint,
> therefore does NOT need a Tenant-RLS role/policies. The Tenant
> SMS-OTP infrastructure that exists today (built in Phase 2) is
> currently unused by any data endpoint.
>
> This spike is therefore **future infrastructure** for whenever a
> Tenant-authenticated data path lands (a hypothetical Phase 6+ feature
> like "resident dashboard — log in via OTP, see your own apartments
> and pending signatures"). The design remains valid for that future
> phase, but it is NOT on the Phase 5 critical path and SHOULD NOT
> block Phase 5 work.
>
> **Owner:** whichever phase introduces Tenant-authenticated data
> endpoints. **NOT Phase 5.** **Reviewers:** founders at that phase's
> PR.
>
> **Why this spike still exists:** Option B is the only spec-compliant
> implementation (per D.20 + docs/07 §9 T01 + D.21) for whenever it IS
> needed, and capturing it in cold blood now (rather than under sprint
> pressure later) is the original justification. Just don't act on it
> yet.
>
> **References:** docs/07 §3 (defense in depth), §9 T01 (Tenant sees
> another tenant's apartment), §6.5 (Tenant SMS-OTP), DECISIONS D.20
> (Tenant role), D.21 (owned auth), D.29 (tier-isolated audiences),
> D.30 (multi-org phone disambiguation), D.31 (audit-pass IV tracker).

---

## 1. The problem in one paragraph

Phases 0–4 built the **org tier** and the **provider tier**: each tier
gets its own JWT audience (D.29), its own DB role (`app_user` /
`provider_user_role`), and its own RLS policies. The **Tenant tier**
(D.20: a resident authenticated by SMS OTP, scoped to their **own owner
record**) is currently auth-only — the OTP service mints a
`tenant_access` token (D.29 aud=`emapp-tenant`), but no Tenant-facing
data endpoint exists yet. Phase 5 will add at least signatures
(signing project documents) and possibly an "own apartment" read view.
Before we write the first Tenant data path we must decide **how the
Tenant's RLS scope is enforced**, because the wrong shape becomes
load-bearing on day 1 and is painful to reverse later.

---

## 2. What the spec already locks in

- **D.17 / D.20:** a Tenant sees their **own owner record only**. Not
  all owners of the same apartment. Not all apartments in the same
  building. Not all signatures in the same project.
- **docs/07 §9 T01 (Critical threat):** three defense layers must hold —
  RBAC at the controller, service-layer JWT-derived scope, **RLS
  on `apartments` filtering by `tenant_user_id`** at the bottom.
- **D.29:** JWT audience `emapp-tenant` is structurally distinct; an
  org/provider token cannot reach a Tenant endpoint.
- **D.30:** the same phone may be an owner in multiple orgs. OTP request
  pins `(phoneHash, org_slug)` when provided, else proceeds only if
  EXACTLY ONE owner matches. The minted token therefore carries one
  unambiguous `(orgId, ownerId)`.
- **D.21 owned auth:** every customer-data read goes through
  `withTenant(orgId, …)` or `withProvider(providerUserId, …)`. Direct
  `db.query` from app/controller code is forbidden.

The Tenant token payload today (`tenant-auth.guard.ts`):

```ts
{ sub: ownerId, orgId, role: 'tenant', type: 'tenant_access' }
```

So at request time we have both **orgId** (already a GUC) and
**ownerId** (the new dimension). The question is how to project
`ownerId` into the database session so RLS can reject a forged
`/tenant/apartments/:id` even if RBAC + service-layer scoping are
bypassed.

---

## 3. Options considered

### Option A — single new GUC `app.tenant_owner_id`, reuse `app_user` role

Add one GUC; widen every Tenant-visible table's existing policy with an
extra branch (`OR tenant_owner_id_matches`).

- **Pro:** smallest delta to the schema. One new wrapper, no new role.
- **Con (fatal):** the existing org-tenant*isolation policy on
  `apartments` is `organization_id = current_setting('app.organization_id')`
  — i.e. ANY caller with the right `app.organization_id` GUC sees ALL
  apartments in that org. A Tenant connection sets the same GUC, so the
  org branch matches \_first* and the Tenant sees the entire org's
  apartments. Defeats T01. To fix it we'd need to gate the org branch
  on "no tenant GUC set" — fragile, easy to mis-write, every new
  Tenant-visible table re-litigates this. **Rejected.**

### Option B — separate `tenant_user` DB role + tenant-specific policies _(recommended)_

Mirror the precedent we already use for the org/provider split: a new
restricted Postgres role with its own policies on the subset of tables
a Tenant is allowed to see.

- **Schema delta (Gate-2 — must be a migration, founders co-author):**
  - `CREATE ROLE tenant_user NOLOGIN`; no `BYPASSRLS`.
  - On the Tenant-visible tables (initial set: `owners`, `apartments`,
    `signatures`-when-it-lands, `documents`-when-Tenant-readable),
    `GRANT SELECT` to `tenant_user`. **No INSERT/UPDATE/DELETE** for
    now (signing flows write via a service-layer choke point that runs
    as `app_user` with an explicit ownerId match — keeps writes
    auditable through the same path as org writes).
  - New policies on those tables, scoped to `TO tenant_user`: - `owners`: `id = current_setting('app.tenant_owner_id', true)::uuid
AND organization_id = current_setting('app.organization_id', true)::uuid` - `apartments`: `EXISTS (SELECT 1 FROM ownerships o WHERE
o.apartment_id = apartments.id AND o.owner_id =
current_setting('app.tenant_owner_id', true)::uuid AND
o.ended_at IS NULL) AND organization_id = …` (own
    apartments via active ownership). - `documents` (when Tenant-readable): same EXISTS pattern joined
    through `apartment_id`, restricted to document types the Tenant
    is allowed to see (decided per-document-type at Phase 5 scope-
    lock). - `signatures`: `owner_id = current_setting('app.tenant_owner_id')`
    — a Tenant can only see THEIR OWN signature artifacts (not
    other owners of the same apartment).
  - **No widening** of any existing `app_user` / `provider_user_role`
    policy. They keep doing exactly what they do today.
- **Code delta:** one new wrapper
  `withTenantUser(orgId, ownerId, fn)` in `packages/db/src/wrappers/`,
  parallel to `withTenant`:
  ```text
  BEGIN
  SET LOCAL ROLE tenant_user
  SELECT set_config('app.organization_id', $1, true),
         set_config('app.tenant_owner_id', $2, true),
         set_config('app.encryption_key', $3, true)
  … fn(tx) …
  COMMIT
  ```
  Note `SET LOCAL ROLE` to `tenant_user` (not `app_user`). RLS
  policies are role-scoped, so a Tenant connection cannot fall
  through to an org policy.
- **Pro:**
  1. Fail-closed at the DB layer. Even a service-layer bug that forgets
     to filter by ownerId cannot leak — the policy itself enforces it.
  2. Pattern symmetric with what we already do for org/provider.
     Reviewers reading `withTenant` already know how to read
     `withTenantUser`.
  3. New Tenant-visible tables (e.g. when a Tenant-readable subset of
     `documents` lands) just GRANT SELECT + a new policy `TO
tenant_user` — additive, no edits to existing policies, no risk
     of regression on the org path.
  4. Audit visibility is preserved: writes still go through
     `app_user` services that already write audit rows; we don't
     introduce a write path that bypasses the audit middleware.
- **Con:** one extra Postgres role to manage; one Gate-2 migration (RLS
  - role + grants); the spike must enumerate the Tenant-visible table
    set carefully before that migration lands.

### Option C — service-layer ownerId scoping only, no Tenant-specific RLS

Keep using `withTenant(orgId, …)` for Tenant requests too, and just add
`AND ownerId = X` predicates in every Tenant service method.

- **Pro:** zero schema delta.
- **Con (fatal):** **violates docs/07 §3 defense-in-depth**, which is
  the spine of our security story. One forgotten `AND ownerId = X` in
  one query becomes a cross-tenant data leak with no Postgres-layer
  catch. **Rejected.** (We rejected the equivalent shortcut for
  Provider in Phase 2 for the same reason.)

---

## 4. Recommendation

**Adopt Option B.** Same governed pattern as `withTenant` /
`withProvider`; same defense-in-depth posture; cost is one focused
migration + one new wrapper + per-table policy review at Phase-5 scope
lock. Worth the investment because the alternative (Option C) breaks
the security story we've already built four phases of evidence around.

---

## 5. Open questions to resolve at Phase-5 scope lock (BEFORE migration is written)

1. **Tenant-visible table set.** Confirmed for spike: `owners` (own
   row), `apartments` (own active-ownership), `signatures` (own).
   **Open:** which slices of `documents` does a Tenant get to read?
   (Their own signature page? The full project contract template? A
   Tenant-summary derived view?) — Phase 5 product decision.
2. **Multi-org Tenant UX.** D.30 minted the right token; do we surface
   "you also own a flat in Org B — switch?" in the Tenant UI, or are
   sessions strictly per-(phone, org) with the FE forcing re-OTP per
   org? Affects token TTL + refresh story.
3. **Tenant refresh token (D.31 (d) deferred).** Spec says 30min access
   - 24h refresh; impl currently re-OTPs every 30min. Decide at
     Phase-5 start — a refresh token would land alongside the wrapper,
     so the wrapper signature can take a session-id parameter in the
     first place if needed.
4. **Signature write path.** Does the Tenant directly write to
   `signatures` via `withTenantUser` (needs INSERT grant + a strict
   policy that forces `owner_id = current_setting('app.tenant_owner_id')`),
   or does the Tenant POST a payload to an `app_user` service that
   inserts on their behalf? The second is cleaner for audit; the first
   is cleaner for cryptographic non-repudiation (the row is provably
   written under the Tenant's own DB session). **Recommendation:**
   the second — keep the audit pattern uniform; record this as a
   sub-decision when Phase 5 starts.
5. **Audit `actor_type` for Tenant.** Currently OTP audit uses
   `actor_type='system'` with the Tenant identity in
   `target_table='owners' + target_id=ownerId` (D.31 fix). When Tenants
   actively perform signatures, do we widen the
   `audit_log_actor_type_valid` CHECK to include `'tenant'`? D.31 (a)
   already flagged this. Decide as part of the Phase-5 audit-pattern
   confirmation.
6. **RLS test harness for the Tenant role.** Add Tenant-tier red-team
   probes to `redteam.ts` — at minimum: forge a Tenant token for a
   foreign ownerId in the same org → 404 (RLS strips the row); forge
   one for a different org → 404; forge an org token at `/tenant/*`
   → 401 (D.29). Pattern already in place for L1–L5 (provider/org tier
   forgery); just adds T1–T3.

---

## 6. Non-goals (explicitly out of this spike)

- Defining the Tenant signature UX or the document-display surface
  (Phase 5 product work).
- Implementing the migration or the wrapper (this is design only — no
  code change here; if we'd written code it would be commits, not a
  spike doc).
- Reversing any earlier decision (D.20/D.21/D.29/D.30 all stand).

---

## 7. Exit criteria for this spike

**Revised 2026-05-20:** there is no upfront sign-off gate. The
implementing agent proceeds with Option B (per the status block above)
as the spec-compliant implementation, in the same way prior phases
implemented their schema changes — founders review the migration in
the Phase-5 PR. On PR merge, a consolidating `D.33 Tenant data RLS
pattern` entry lands in docs/DECISIONS.html recording the realised
implementation (commit SHA, migration number, the policies as
shipped). The six open questions above remain deferred to Phase-5
scope-lock — they are product/UX choices, not architecture, and are
not pre-requisites for opening Phase-5.
