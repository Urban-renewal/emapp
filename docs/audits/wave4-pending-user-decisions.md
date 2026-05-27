# Wave 4 — Pending User Decisions (from 2026-05-27 Manager-BE audits)

**Status (2026-05-28): all four items resolved.** Section preserved as the audit trail.

| #   | Item                                                                  | Resolution                                                                  | Reference   |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| 1   | H-3 sec — `signature_requests` Agent visibility scope (Gate-6 POLICY) | **Kept current** (option A — multi-agent collaboration on assigned project) | D.43 + #150 |
| 2   | M-1 sec — `tenant_sessions` table                                     | **Shipped** (migration 0038 + `POST /portal/logout` + TTL 30→10 min)        | #152        |
| 3   | C-2 err — audit-orphan reconciliation                                 | **Inline (option B)** for the import-upload site; outbox deferred           | #151        |
| 4   | M-7 err — optimistic locking on PATCH                                 | **Deferred to V12** (no observed real-world race; documented gap)           | D.44 + #150 |

Waves 1-3 already shipped 15 findings (#146 + #147 + #148). Wave 4 was everything that either needed a POLICY change, a schema migration that crosses multiple existing tables, or a cross-cutting API contract change.

The historical write-up of each option / recommendation is preserved below as the rationale trail.

---

## H-3 — `signature_requests` Agent visibility (Gate-6 POLICY)

**The question**: should an Agent see signature_requests that another Agent on the same project issued?

**Current behaviour**: `POLICY.signature_requests.read = ALL` (manager/agent/viewer), but the service-layer agent-scoping at `signature-requests.service.ts:349-369` OR-joins "doc has project agent is assigned to" with "doc has apartment whose project agent is assigned to". So today: an Agent assigned to project X can see EVERY signature request on every doc in project X, including those another Agent issued.

**Spec ambiguity**: D.17 says "agent → assigned projects" — silent on whether that means "can read everything in that project" (current behaviour) or "can read their own writes only" (stricter).

**Two paths**:

- **(A) Keep current — Agent sees all sigreqs in their assigned project.** Pro: matches the comment "agent → assigned projects = read all". Pro: useful UX — agents collaborating on the same project see each other's progress. Con: a compromised Agent cookie exfils more PII (the sig request includes recipient + status).
- **(B) Tighten — Agent sees ONLY sigreqs they created.** Pro: minimum-privilege; smaller PII surface if compromised. Con: breaks team workflows where Agents pick up each other's threads. Con: requires a `created_by_agent` filter in the list query + an explicit POLICY entry.

**My recommendation**: **(A) — keep current**. The product is multi-agent collaborative; teams will hate (B). The compromise risk is bounded (sig requests show recipient name + status, not the underlying ID). If the user wants the stricter posture, that's a 1-day PR (filter + spec).

**To ship**: tell me A or B.

---

## M-1 — `tenant_sessions` table + Provider Admin tenant-revoke

**The question**: should we add a session table for tenant JWTs so they can be revoked before TTL expiry?

**Current behaviour**: `POST /api/v1/auth/otp/verify` mints a 30-minute tenant JWT with no `sid` claim and no DB row. Once minted, it's valid until expiry — no revocation path. If a tenant's phone is stolen at minute 0, the attacker has 30 minutes of full portal access (read PII for that owner).

**The scope**:

1. Schema migration: new `tenant_sessions` table (id PK, owner_id FK, org_id FK, issued_at, expires_at, revoked_at).
2. `otp.service.ts:191-194` mints with a `sid` claim, inserts a `tenant_sessions` row.
3. `TenantAuthGuard` reads the sid claim, calls `isTenantSessionActive(sid)` against the table (cache as we do for `auth_sessions`).
4. New `POST /api/v1/portal/logout` — tenant kills their own session.
5. New Provider-Admin endpoint `POST /api/v1/provider/tenants/:ownerId/sessions/revoke` — provider admin kills a tenant session on user request ("I lost my phone").

**Tradeoffs**:

- Cost: ~1 day of work + a migration + cache invalidation logic.
- Benefit: a real "kill session now" path that matches the org-tier behaviour.
- Sub-15-min TTL would partially mitigate (current is 30); the cheapest interim fix is to drop TTL to 10 minutes.

**My recommendation**: **ship `tenant_sessions` table + portal/logout BUT defer the Provider Admin revoke endpoint to V12**. The self-logout is cheap and high-value; the cross-tier admin revoke needs UI design work for Track A and isn't blocking MVP.

**To ship**: say "go on M-1" and pick interim TTL (10 min / 15 min / 30 min keep).

---

## C-2 — Audit-orphan reconciliation (transactional outbox)

**The question**: how do we guarantee every action that requires an audit row gets one, when the audit write happens in a SEPARATE tx from the action?

**The hole**: two concrete sites:

1. `imports.service.ts:555-563` — after the presign-mint commits, a SECOND `withTenant` writes `import.upload_url_minted`. If the second tx fails (DB blip), the URL was minted-and-returned but NO audit row exists. Manager downloaded a bearer credential with no forensic trail. ISO 27001 A.12.4.1 violation.
2. `auth.service.ts:560-575` `writeLoginAuditSafe` — best-effort swallow. A DB hiccup loses login-failure audit rows that the Provider-Admin compliance dashboard depends on.

**Two paths**:

- **(A) Transactional outbox** — append the audit event to an `audit_outbox` table inside the SAME tx as the action. A background worker drains the outbox to `audit_log`. Guarantees: every committed action eventually has an audit row. Cost: schema (outbox table) + worker code + monitoring.
- **(B) Inline only** — never write audit in a separate tx. Restructure the import upload flow so the audit write IS the same tx as the row UPDATE (move it before `commit`). For login failure: same, restructure to use the same connection. Cost: refactor of ~5 sites. No new infra.

**My recommendation**: **(B) — inline only, ship per-site as I find them**. (A) is the right long-term answer but introduces a new piece of infra. The current best-effort swallow is mostly fine for non-compliance use; the import-upload one specifically should land in the same tx.

**To ship**: say "go on C-2 (B)" and I'll fix the import-upload site as a Wave 5 PR.

---

## M-7 — Optimistic locking on PATCH (concurrent edit race)

**The question**: should every mutate endpoint accept an `If-Unmodified-Since` header or `expectedUpdatedAt` body field and 409 on mismatch?

**The hole**: today, two managers PATCHing the same project simultaneously → last-write-wins, the second silently overwrites. Same for apartments, tasks, documents, owners, ownerships. The audit row's `before` reflects what THIS manager saw, not what landed before them — forensics get muddy.

**Impact assessment**: **low for projects** (rare edit collision in practice — a real "two managers editing the same project" event is uncommon for the SMB target). **Higher for ownerships** (the sum-to-100 trigger already racses correctly via tx, so atomicity holds — but the wire shape `replaceSet` blindly overwrites the old set).

**Two paths**:

- **(A) Per-resource opt-in** — add the precondition only to resources where the user reports a collision in practice. Cost: per-resource. Risk: we never get coverage.
- **(B) Global pattern** — add a `version` column to every mutable table, bump on UPDATE, controllers check via header. Cost: 1 migration + 1 interceptor + ~10 controller annotations. Risk: cross-cutting churn.

**My recommendation**: **defer to V12**. None of the audited sites have a real-world race report; opt for clean behaviour later when there's a concrete UX complaint. Document the gap in DECISIONS so future agents don't re-discover it.

**To ship**: say "defer M-7 to V12 + add DECISIONS entry" (my default) or pick A/B.

---

## How to drive this

When you're back, reply with one line per item, e.g.:

> H-3: A · M-1: go on, TTL=10min · C-2: B · M-7: defer

I'll spin up the matching PRs immediately. No need to be in chat — drop the line and I'll execute.

Track B — 2026-05-27

---

## Resolution log (2026-05-28)

User reply: "אני מאשר לך להמשיך לפי ההמלצות שלך" (approval to proceed per recommendations, conditional on docs-reading — docs were read before each migration).

- **H-3** → kept current (option A). D.43 entry added to DECISIONS.html.
- **C-2** → option B (inline). PR #151 changed the post-presign audit-write site in `imports.service.ts` from `.catch(swallow)` to a hard `throw 503 audit_unavailable`. The audit-write is now non-optional: if the second tx fails, the URL is not returned. Worker outbox is no longer the only path; this is the smallest correct fix.
- **M-1** → shipped (PR #152). `tenant_sessions` table mirrors `auth_sessions` (RLS-exempt, soft revoke, no DELETE grant). OTP verify mints JWT with `sid` + inserts row. `TenantAuthGuard` checks `isTenantSessionActive` (15s cache). `POST /api/v1/portal/logout` for tenant-initiated revoke. TTL dropped 30→10 min as interim mitigation. Audit row uses `actor_type='system'` (the CHECK constraint rejects `'tenant'`). Provider-Admin cross-tenant revoke endpoint deferred to V12 (needs UI design work).
- **M-7** → deferred to V12. D.44 entry added to DECISIONS.html.

Track B — 2026-05-28
