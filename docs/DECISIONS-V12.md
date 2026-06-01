# EMAPP — V12 Decisions (Stabilize + Complete phase)

> Locked decisions for the post-V11 phase. Continues the D.NN numbering from
> DECISIONS.html. These are LAW for the V12 plan — agents implement, don't
> re-litigate. Each has rationale so a future reader knows _why_.
>
> **Numbering note:** canonical DECISIONS.html ends at **D.44**. An earlier
> draft of this file mis-numbered these as D.42–45, colliding with locked
> decisions. Corrected: V12 decisions are **D.45–D.50**. Any reference to the
> old numbers elsewhere must be updated.

---

## D.45 — User provisioning & onboarding model

**Decision:** provisioning mechanism is matched to the user population; there is
no single "create user" path and **no open/shared-secret signup**.

| Who creates whom                     | Mechanism                                                                                                     | Status          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------- |
| Provider Admin → Org + first Manager | Provider-initiated: create org + send the first manager an **invite-token email** (manager sets own password) | build (Track D) |
| Org Manager → Agent / Viewer         | **invite-token email** (`invite-email.ts`), invitee sets own password                                         | built           |
| Org Manager → Contractor             | **share-link** with scoped perms (see D.46)                                                                   | partial         |
| Resident (דייר)                      | **SMS OTP**, no account, identified by owner record                                                           | built           |

**Rationale:** per-user invite tokens are single-use, expiring, scoped, and let
the invitee set their own credential (ISO A.9.2) — strictly better than a shared
registration key (forwardable, leakable). OTP serves the periphery audience with
zero account management. Consistent with D.21 "no signup".

---

## D.46 — Tenant permission model (Agent matrix + Contractor scope)

**Decision:** the tenant **Manager controls permissions** for both Agents and
Contractors, via a **curated capability matrix** (not atomic per-field perms,
not fixed roles), stored as JSONB (D.17), enforced server-side.

### Field Agent — manager-toggled capability matrix (scoped to assigned projects)

Base (always on once assigned): **view assigned project data**. Manager toggles
per agent (6 curated capabilities, not 15 atomic toggles — extensible later):

| Capability                                          | Default                |
| --------------------------------------------------- | ---------------------- |
| Edit project data (buildings / apartments / owners) | off                    |
| Manage documents (upload / download)                | off                    |
| Manage signatures (create requests)                 | off                    |
| Manage tasks / calendar                             | off                    |
| Run imports                                         | off                    |
| View owners                                         | on (PII masked — D.47) |

### Contractor — per-share resource scope (read + download, no write)

| Resource in share     | Default          | Notes                                                       |
| --------------------- | ---------------- | ----------------------------------------------------------- |
| Project (shared only) | on               | name/type/status/timeline                                   |
| Buildings + sections  | on               | incl. gush/helka                                            |
| Apartments            | on               | structural only — no owner link                             |
| Signature progress    | on               | **AGGREGATE % only** — never who/individual                 |
| Documents             | manager-selected | view + download; only shared docs, NOT per-owner agreements |
| Owners / PII          | off              | never, not even masked, by default                          |
| Tasks                 | off              | only if explicitly invited                                  |

**Extensibility (locked intent):** JSONB capability set (D.17) → future
expansion = enabling more capabilities, no schema change / re-architecture.

**Rationale:** brief required manager-controlled variable perms; D.17 models
contractor JSONB perms. Curated capabilities keep it buildable. **Cost:** adds
the matrix UI + server enforcement + tests to Track D.

---

## D.47 — Resident sees masked PII (resolves SEC-1 / former SEC-1)

**Decision:** `/portal/me` masks the resident's own `national_id` and `phone`
(`•••••••53`), consistent with org-side D.19 masking. No cleartext PII on the
wire, anywhere.

**Rationale:** consistency + minimal exposure + cleanest ISO posture. If a
"reveal" is ever needed it becomes an explicit, audited action — not a default.

---

## D.48 — Provider console on a separate subdomain

**Decision:** the Provider (product-admin) console lives on **`admin.emapp.io`**
— a separate Cloudflare Pages app — not a path on the customer app.

**Implications (locked):**

- `provider_access_token` cookie scoped to the admin subdomain only; never
  shared with the customer app's cookie scope.
- Separate Pages deployment + route-handler clone for the `/api/v1/provider/*`
  proxy.
- Provider login + MFA (D.21) gate the whole subdomain.

**Rationale:** full cookie/blast-radius isolation between the SaaS control plane
and customer tenants. Resolves the long-standing H1 topology open item.

---

## D.49 — Provider write actions authorized (supersedes the D.37 read-only lock)

**Context:** D.37 + `policy.ts:127` (`type ProviderAction = 'read'`) lock the
Provider tier to read-only; all write actions were Gate-6 deferred. The owner's
required "professional SaaS console with control over per-customer values" needs
writes. This decision authorizes them.

**Decision:** open Provider **write** actions — suspend/reactivate tenant, reset
tenant MFA, per-customer config — under hard controls:

- Every write goes through the existing **audit-first `withProvider`** pattern
  (audit row committed in an autonomous tx BEFORE the work — SA-7).
- **`access_reason` required** on every write (already enforced for reads).
- Writes are a **distinct `ProviderAction`** in the policy matrix (`'read' |
'write'`), not a widening of read — least-privilege preserved.
- **Destructive/irreversible** actions (e.g. tenant data purge) remain
  out-of-scope pending a separate decision; this authorizes operational writes
  only.

**Implementation status (deferred parts):** of the three writes authorized here,
only **suspend/reactivate** is built (#182–184) + shipped in D2's console.
**reset-MFA** is deferred to Track C (no enforced org 2FA to reset yet — D.55).
**per-customer config** is deferred pending a concrete, enforced config value
(building config writes that nothing reads = a no-op/plaster — D.51); it returns
to scope when the owner names a real per-customer value to control.

**Rationale:** unblocks the #1 owner want (the console). The audit-first +
reason-required pattern means every Provider mutation is forensically logged —
exactly what ISO A.9/A.12 wants for a privileged control plane. **Cost:** new BE
write endpoints + `policy.ts` matrix change (Gate-6, authorized here) + RLS +
the console UI. Largest single Track-D workstream.

---

## D.50 — Export/download = a projection of read scope, at authorized PII fidelity

**Context:** EXP-M3 — a Viewer (who sees PII **masked**) could export the full
**cleartext** PII via the export endpoint, because the controller allowed anyone
with `projects:read`. The export was a masking-bypass channel.

**Decision (per owner):** **export and download are a strict projection of what
the actor is authorized to READ — never more.** Two sub-rules:

1. **Scope.** You can export/download exactly the resources in your read scope.
   A resource outside your scope → **404 (no-oracle)**, never a minted URL.
   - Manager → all org data · Agent → assigned projects (+ capability gating,
     D.46) · Contractor → the shared scope (D.46) · Resident → only the
     specific document(s) sent to them (e.g. the one signature doc they
     received — they download that, nothing else). IDOR-checked on the
     download endpoint.
2. **PII fidelity (locked default — override only by explicit decision).** A
   **data export** (xlsx/PDF aggregating owner PII) reflects the **same PII
   resolution the actor sees on screen**: Viewer/Contractor → **masked**;
   Manager → cleartext (their authorized view). Export must never reveal PII the
   actor cannot see in the UI — otherwise it re-opens EXP-M3.

**Implementation requirements (fold into the export fixes):**

- Add `export` (or reuse `read` + a PII-fidelity flag) so the controller masks
  per-actor instead of always decrypting.
- **CSV/formula-injection (EXP-C1):** prefix-escape cells beginning `= + - @`
  and strip DDE — for every exported PII/text field, at all fidelities.
- **Heap hygiene (E-C2):** drop/zero decrypted PII in a `finally`.
- **Binary document download:** pure scope check (no fidelity question) — see
  rule 1; IDOR-enforced (matches the D.46 contractor download rule).

**Rationale:** one coherent principle — "you can take out exactly what you can
see, at the resolution you can see it." Resolves EXP-M3 without blocking any
role; folds EXP-C1 + E-C2 in as the safe-implementation requirements. Consistent
with D.46 (contractor read+download) and D.47 (resident masking).

---

## Technical defaults (applied unless overridden)

| ID  | Decision                                                               |
| --- | ---------------------------------------------------------------------- |
| T4  | No shared-secret signup (folded into D.45)                             |
| T5  | ISO target = full Annex A baseline until the auditor narrows scope     |
| T6  | Hosting: colocate app + Neon in EU (perf — kills the remote-RTT floor) |
| T7  | Loading skeletons allowed (polish, not a design change)                |
| T8  | Domain scheme: `app.` / `admin.` / `notifications.` on the chosen root |

## Procurement-pending (design decided; obtain when ready)

| Item         | Design decision                                            | Pending                 |
| ------------ | ---------------------------------------------------------- | ----------------------- |
| SMS provider | behind `ISMSProvider`; `noop` in dev; recommend **Inforu** | open account            |
| ISO scope    | baseline Annex A (T5)                                      | obtain SoA from auditor |
| Root domain  | scheme locked (T8)                                         | purchase domain         |

## Wave4 carried decisions — RULED by owner (2026-05-31)

| ID  | Question                                                                        | Ruling                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-3 | May an Agent read signature_requests another Agent created on the same project? | **Keep collaborative** — agents on a shared project see each other's signature requests (small teams co-work a project). Tighten later only if a customer asks. |
| C-2 | Audit-orphan fix: transactional outbox (A) or inline same-tx (B)?               | **Inline same-tx (B)** — no new infra.                                                                                                                          |
| M-7 | Optimistic locking on PATCH now or defer?                                       | **Defer** to a later slice; gap recorded.                                                                                                                       |

## D.51 — Quality gate + autopilot completion (PROC-3)

**Context:** the verification contract (PROC-1/2) proves a fix is _correct_
(test red→green). It does **not** prove the fix is _optimal_ — a plaster
(caching hack, swallowed error, special-case) can turn a test green without
addressing the root cause. The owner's stated fear: an agent understands the
problem but ships a shortcut. This decision closes that gap.

**Decision — three mechanisms, all merge-blocking:**

1. **Root-cause statement on every fix-PR.** The PR description must state:
   (a) what causes the symptom, (b) that the fix addresses _that cause_ (not the
   symptom), (c) the simpler approach considered and why it was rejected as a
   plaster. No statement → not mergeable.

2. **Mechanism-based acceptance criteria, not symptom-based.** Every
   verification criterion must be one a plaster _cannot_ pass. Not "latency
   <1s" (a cache passes it) but "EXPLAIN shows index scan; withTenant = 1
   round-trip, measured". Not "no console error" but "the specific guard fires
   with this input". Rule of thumb: **if a plaster would also make the test
   pass, the test is too weak — strengthen it to assert the mechanism.** The
   FINDINGS-REGISTER verification column is rewritten to this standard.

3. **Anti-plaster review (G0.3 extended).** The code-review/security-review
   skill explicitly hunts plaster-signals: caching that hides instead of fixes,
   try/catch that swallows, magic constants, special-casing, "TODO: real fix
   later". A flagged plaster blocks merge until reverted to a root fix.

**Autopilot completion (the owner's rule):** an agent does NOT finish a slice
or advance to the next until **all its verification is green** — the slice's
test red→green AND the full CI suite (the 8 required checks, now branch-
protection-enforced) AND the mechanism criteria. "Opened a PR / CI is running"
is **not** done; "all checks green, merged" is done. The agent waits out its
own CI and fixes failures before moving on — it never leaves a slice half-
verified. (Demonstrated live: #134 was not declared done until its e2e went
green; the plausible-but-unverified cold-compile guess was explicitly NOT
shipped.)

**Rationale:** correctness gate answers "does it work"; quality gate answers
"is it the right fix"; autopilot completion ensures the agent actually closes
the loop instead of leaving green-pending work behind. Together they make
"optimal, not plaster" a mechanical gate, not an ad-hoc judgment.

---

## D.52 — PERF-1 round-trip floor = 3 (spec-safe); ≤2 rejected; latency via T6

**Context:** the FINDINGS-REGISTER set PERF-1's target at "≤2 round-trips" for
`withTenant`. The A1 agent proved that target unreachable without a security
regression: collapsing the setup into a single statement to hit 2 requires the
**simple protocol** (no parameter binding), which forces the PII **encryption
key into the query text** → it lands in DB query logs, violating **spec §10.3**
(key must stay parameter-bound, never logged). The session-level workaround
leaks GUCs across pooled connections under the Neon transaction pooler (proved
mechanically). The agent reverted to the safe path and stopped for this ruling.

**Decision (owner, 2026-05-29):**

1. **Reject ≤2 / inline-key.** We do not trade a PII/ISO control (§10.3) for one
   round-trip. The encryption key stays **parameter-bound**.
2. **The round-trip floor is 3** (open+SET ROLE · set_config params · COMMIT) —
   the safe minimum under §10.3 + the Neon pooler. The big win (4–6 → 3) is
   already banked; PERF-1's deliverable is to **lock 3 as a CI regression gate**
   (`perf-1-withtenant-roundtrips.spec.ts`, budget `≤3`), so no future change can
   regress back toward 4–6.
3. **Absolute latency is a deployment concern, not a code concern.** The felt
   slowness is the remote-DB distance (~138ms/hop), not the round-trip _count_.
   It is solved by **T6 colocation** (app in Neon's region), which collapses each
   hop to ~1ms. This is **already decided (T6)** and **tracked at the Pre-launch
   milestone PL1** (`MASTER-PLAN-V12.md`) + the region step in
   `SETUP-EXTERNAL-SERVICES.md`. **Do not act on it during V12 code work** — it
   is a deploy-time step, gated at PL1 (launch is blocked until the colocated-DB
   pass is done).

**Rationale:** count = throughput ceiling (locked at the safe floor of 3);
distance = felt latency (killed by colocation). Both axes are covered, neither
sacrifices §10.3. "Minimal runtime" = minimal _safe_ round-trips + colocation,
not a logged encryption key.

**No open ends:** the colocation step you must not forget is mechanically held
by **PL1** (a launch-blocking pre-launch gate) — see Plan impact below.

---

## D.53 — PERF-2 (getMe SSR self-hop) deferred to the infra/deploy layer (with T6)

**Context:** PERF-2 — server-side `getMe` fetches `${origin}/api/v1/me`, i.e. its
**own** Next proxy route, which then forwards to `API_BACKEND_URL`. This
self-dependency double-hops every authenticated page render and deadlocks the
**dev** server under load (one Node process calling itself). Track B (FE)
analysed it and stopped: every clean fix crosses its surface boundary.

**Decision (owner, Option D):** **defer the root fix to the infra/deploy layer,
paired with T6.** Rejected alternatives:

- **A — self-hop bypass (SSR calls the backend directly).** The correct root
  fix, but it changes the deliberately-centralized `selfOrigin` / single-backend
  hostname boundary and has **prod-runtime behavior (Cloudflare Pages → private
  Railway) that cannot be verified in dev**. A blind, unverifiable fix is not
  shipped — it is done at deploy, **where the prod topology exists and is
  verifiable**, alongside T6. Add a server-side timeout there as defense-in-depth.
- **B — session-validity cache.** **Rejected** — widens the token-revocation
  window (auth-freshness regression, intersects redteam-H-1). Same
  security-for-perf trade rejected in **D.52**.
- **C — timeout only.** Symptom, not root (D.51-weak). Folds into A as hardening.

**Rationale:** PERF-2's pain (~460ms + dev deadlock) is largely a remote-DB
distance + dev-environment artifact — the SAME thing **T6 colocation** + prod
scaling absorb (like D.52's latency). The architectural cleanup (A) belongs with
the prod topology, where it is verifiable. Deferring is the disciplined call.

**No open ends:** held by **PL1** (the launch-blocking gate) — the infra owner
fixes PERF-2 (option A + timeout) when colocation lands. Full root-cause analysis
preserved in `docs/heartbeats/track-b/2026-05-30.md`.

---

## D.54 — Tenant access model: per-person capability set (read fidelity + grouped writes)

**Context:** D.46 defined a manager-toggled capability matrix for Agents, with
owner PII masked. Field reality (owner: a field agent must _call_ owners and
_verify identity_ for signatures) makes "agent always masked" wrong. And a field
person wears multiple hats (documents + signatures + …). This decision makes the
full tenant access model explicit. It **refines D.46**, **supersedes the
"org-staff always masked" assumption of D.19/D.46**, and threads **D.50** (export).

**Decision — access under a tenant is a per-membership capability set (JSONB),
composed by the tenant Manager. Roles are presets, not rigid bundles.** Two axes,
both manager-controlled per person:

1. **Read PII fidelity — `masked` | `unmasked`, via reveal-on-demand (refined,
   #192).** Default **masked** (least-privilege); the `view_owner_pii` capability
   grants `unmasked` per person (field staff who need real `national_id`/`phone`).
   **Mechanism (locked to "B" — server-side, not display-masking):** all bulk
   surfaces — list, detail, **export (D.50)** — are **ALWAYS masked for everyone**;
   cleartext never crosses the wire in bulk (the `…Masked` field is the
   §v9-M-4 tripwire). Cleartext is obtained **only** via a dedicated, capability-
   gated, scope-checked, **per-access-audited** reveal endpoint
   (`POST /owners/:id/reveal-pii`, `owner.pii_revealed`, ISO A.12.4 — logs
   who/which owner/which fields, **never the values**), one owner at a time.
   Gate order (no-oracle): `view_owners` (outer) → existence → scope → `view_owner_pii`.
   Rejected "A" (cleartext in the bulk list when unmasked): it loses the
   "schema strips all cleartext" defense and the bulk-list tripwire — reveal-on-
   demand keeps both and adds per-access audit. **Invariant:** `view_owner_pii`
   ⇒ `view_owners` (enforced at the capability PATCH).
2. **Write capability groups (coarse — NOT per-field, for regulatory clarity):**
   `edit_project_data` · `manage_documents` · `manage_signatures` ·
   `manage_tasks` · `run_imports`. Manager grants **any combination** (multi-hat).

**Role presets = the MVP "profiles".** The 4 roles (Manager / Agent / Viewer /
Contractor) are named default capability sets; the manager assigns a role and
**tweaks per person** (override). At MVP scale (3–15 people per tenant, residents
excluded) this fully covers the need and is audit-friendly ("role=agent + these
overrides"). A **separate user-defined-profiles subsystem is fast-follow** —
trigger: a customer reaches ~20+ field staff, or requests a custom named profile.

**The preset default capability sets (locked):**

| Role              | Read fidelity                    | Write groups       | Notes                                                                                                                                                     |
| ----------------- | -------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manager**       | unmasked                         | **all**            | full create/write/modify                                                                                                                                  |
| **Agent** (field) | masked                           | **none** (all-off) | least-privilege START — `view_owners` on (masked); manager toggles up what's needed (incl. `view_owner_pii`). This is the migration-0041/0042 DB default. |
| **Viewer**        | masked                           | none               | read-only org-wide; no `view_owner_pii`                                                                                                                   |
| **Contractor**    | masked (owners-PII off entirely) | none               | share-scoped read + download (D.46)                                                                                                                       |

So a fresh Agent starts at the floor and the manager grants exactly what that
field person needs — least-privilege by default, not a permissive bundle.

**Enforcement (security — how privilege escalation is prevented):**

- **JWT carries only the role, never capabilities** — capabilities are loaded
  server-side from the membership per request. Nothing capability-related is
  client-supplied → no token tampering.
- **Two gates:** coarse role-gate in `POLICY` (the matrix) + **fine gate in the
  service** (`requireAgentCapability` reads the flag from DB) **and** a scope
  gate (assigned-project / active-ownership join). Both must pass; both are
  server-authoritative.
- **Both axes are separate** (verified #186): capability without assignment →
  blocked; assignment without capability → blocked. Neither implies the other.
- **Active-only:** assignment and ownership must be active (`ended_at`/
  `unassignedAt` IS NULL) — no escalation via stale grants.
- **RLS underneath** (`withTenant`): cross-tenant access is impossible at the DB
  layer even if a service check is missed.
- **Granting is manager-only**, target=agent, audited — no self-escalation.
- **Mechanical fail-open guard (required):** a CI guard (like the
  tenant-isolation guard) **fails the build** if any endpoint on a POLICY cell
  loosened to agents does **not** call `requireAgentCapability`. Turns the
  no-side-door rule from reviewer-judgment into a wall.

**Audit:** capability/role changes + `unmasked` grants are audited. Per-access
logging of `national_id` reads (ISO A.12.4 — who _viewed_ sensitive PII) is a
**target**, shaped by the ISO SoA (ISO-SCOPE).

**Extensibility:** new external roles (e.g. lawyer — _not_ MVP) = a capability
preset on the same perms-driven model; no re-architecture.

**Rationale:** matches the real field workflow, keeps an ISO-correct posture
(need-to-know + audited + coarse groups + masked-by-default), and is **fully
additive** to what is built (#185/#186 stay; add the PII-fidelity capability +
one resolver + the fail-open guard). PM scope discipline: profiles deferred
because at 3–15 people per tenant the role-presets are the profiles.

---

## D.55 — 2FA model: Provider mandatory + controlled break-glass; org opt-in

**Context:** D.21 makes Provider MFA mandatory. The owner wanted an emergency
path (lost device / "local account") and proposed making it optional. Optional
MFA on the **cross-tenant super-admin** (keys to every customer's PII) is a
security downgrade — the wrong mechanism for a legitimate break-glass need.

**Decision (Track C / ISO — not D2):**

- **Provider Admin: MFA stays mandatory (D.21 holds), NOT self-disable-able.**
  Break-glass is a **controlled** path, not an off-switch:
  - **Recovery codes** — one-time backup codes issued at enrollment, stored
    offline; logging in with one IS a second factor. Standard TOTP break-glass.
  - **Break-glass local account** — a dedicated emergency account, offline creds,
    emergency-only, **every login alerts + audits**.
  - (With ≥1 Provider admin: peer MFA-reset, controlled.)
- **Org users: 2FA optional / opt-in** — each customer decides for its members.

**Rationale:** delivers the owner's break-glass need **without** opening the
front door — you can never log in without a second factor, but there is an
audited emergency path. ISO A.9 for privileged accounts. **This is a Track C
feature (the 2FA build), gated by ISO-SCOPE; it does NOT touch D2.** (This is
why D2 ships no `reset-MFA` UI — there is no enforced org 2FA to reset yet.)

---

## D.56 — admin.emapp.io subdomain deferred to pre-launch (domain-gated); Provider built in-place now

**Context:** D.48 puts the Provider console on a separate subdomain
(`admin.emapp.io`) for cookie/blast-radius isolation. The owner will purchase the
domain only once the product works end-to-end — so the subdomain can't exist yet.

**Decision:** **build the full Provider console in-place now** (under the existing
`/provider/*` routes, gated by provider login + the provider-authorization guard),
and make the **`admin.emapp.io` cutover a launch-blocking PL gate** tied to the
domain purchase — exactly the pattern used for colocation (D.52) and PERF-2
(D.53). Everything is built and functional **except** the literal domain + DNS +
cookie-scope flip, which is a documented, un-loseable pre-launch step (PL).

**Interim posture:** during the in-place period (dev / pre-domain, no real
tenants) the provider console shares the app's cookie scope; isolation is
provided by provider login + MFA (D.21/D.55) + the provider-authorization guard.
The **separate-subdomain cookie isolation** (the full D.48 posture) lands at the
PL cutover. No real customer data is exposed in the interim (dev only).

**Rationale:** decouples the entire Provider-console build from domain
procurement (which has external lead time), without losing D.48 — the isolation
step is held mechanically by the PL gate, like colocation.

**Domain name = config-driven placeholder (not yet chosen).** `emapp.io`
everywhere in these docs is **illustrative**, not a committed name — the root
domain is a **PL-time decision** (owner picks + buys before launch). The scheme
is locked (T8: `app.` / `admin.` / `notifications.` on the chosen root); only the
root is open. **The build MUST NOT hard-code the literal domain** anywhere —
cookie-domain, invite-email links, `API_BACKEND_URL`, and the subdomain origins
all come from **env/config**. Picking the real name later = a config change, not
a code change. (Agents: never write `emapp.io` into code; read it from config.)

---

## D.57 — Live signature progress = active-doc consent only (archived excluded), uniform portal + contractor

**Context:** the aggregate signature-progress count (tenant portal slice 5 +
contractor read-tier DEF-1, both via the shared
`signatureProgressByProject` / `projectSignatureDocIdsSql` resolver) was being
hardened for perf (D.51/D.52). The original `(d.project_id = P OR
b.project_id = P)` predicate counted signatures on **archived** documents too,
because it had no `archived_at` filter. The perf rewrite surfaced the question:
should a signature on a **superseded (archived)** agreement count toward live
progress?

**Decision (owner-approved):** **No.** Live signature progress counts only
signatures on **ACTIVE** documents — `archived_at IS NULL` on both UNION
branches of the doc-id set. This is **valid-consent semantics**: a signature on
an agreement that has since been replaced is not valid consent and must not
inflate the live completion %. The rule is **uniform** across the tenant portal
and the contractor read-tier (one shared resolver), and is **consistent with
`getDocuments` / `getProject`**, which already exclude archived.

**Status:** this is a **deliberate, approved behavior change** — NOT byte-for-
byte with the pre-hardening OR-form (which counted archived). It is a
correctness fix, not a perf-PR regression.

**Mechanism bonus (not the driver):** the `archived_at IS NULL` predicate also
makes the existing **partial** indexes `idx_documents_org_project` /
`idx_documents_apartment` (both `… WHERE archived_at IS NULL`) usable, giving
the count an index path (D.51) with **no new index / no migration**. Correctness
and perf land on the same predicate. (A count-neutral variant without the filter
could not use the partial indexes and failed the perf gate on CI's clean DB.)

**Tests pinning it:** `portal.s4` #9 and `contractor-read.spec`
("D.55 valid-consent…") both seed an archived signed request and assert
`signaturesSigned` is unchanged; `signature-progress-perf.spec` asserts the
index path under `enable_seqscan = off`.

---

## Plan impact

- **D.46** adds a permission-model slice to Track D.
- **D.48** adds a second FE app (admin subdomain).
- **D.49** unblocks + enlarges the Provider console (BE writes + policy change).
- **D.50** reshapes the export fixes (per-actor masking + injection-escape + heap drop).
- **D.47** shrinks SEC-1 to a small masking fix.
- **D.45** confirms existing invite/OTP/share primitives — mostly built.
