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

## Still-open decisions (carried from wave4 audit — owner to rule)

| ID  | Question                                                                        | Recommendation                                                          |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| H-3 | May an Agent read signature_requests another Agent created on the same project? | Keep current (collaborative) — A. 1-day PR to tighten if owner prefers. |
| C-2 | Audit-orphan fix: transactional outbox (A) or inline same-tx (B)?               | B (inline per-site) — no new infra.                                     |
| M-7 | Optimistic locking on PATCH now or defer?                                       | Defer to a later slice + record gap.                                    |

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

## Plan impact

- **D.46** adds a permission-model slice to Track D.
- **D.48** adds a second FE app (admin subdomain).
- **D.49** unblocks + enlarges the Provider console (BE writes + policy change).
- **D.50** reshapes the export fixes (per-actor masking + injection-escape + heap drop).
- **D.47** shrinks SEC-1 to a small masking fix.
- **D.45** confirms existing invite/OTP/share primitives — mostly built.
