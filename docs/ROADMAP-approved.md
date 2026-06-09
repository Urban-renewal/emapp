# ROADMAP — Owner-approved backlog (authoritative build order)

> Single source of truth for the autonomous run. Owner approved the decisions
> below on 2026-06-09. Build STRICTLY in the priority order in §2 (owner: "the
> building should be in order"). Do NOT skip ahead. Update status inline as items
> ship. Every Gate-2/Gate-6 item needs security-review + owner merge.

> **⭐ STANDING MANDATE (owner, 2026-06-09): every implementation + action must be
> done in the MOST PROFESSIONAL way — MODULAR, GENERIC, and SOLID at EVERY step —
> so the eventual production transition is smooth and future hardening of the
> process does NOT break the system. SOLID is a per-step gate: each builder applies
> single-responsibility, open/closed (extend without modifying), interface-driven
> seams, and DI. Every code-review checks it. Non-negotiable.**

## 1. Decisions (locked)

| #   | Decision                   | Resolution                                                                                                                                                                                                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Consent threshold 66 vs 67 | **66** default, AND make it **org-configurable in Settings** (surface/create the org-level consent-threshold setting so each org sets its own). Per-project override stays.                                                                                  |
| 2   | Gate-6 merge order         | **#325 (migration 0053) FIRST, then #326 (0054)** — natural order; preserve the migration-chain `when` monotonicity. Verify `when` at each merge.                                                                                                            |
| 3   | Commit the plan docs       | Not mandatory, but **MUST NOT be lost in the autonomous run** → committed here + tracked in this roadmap.                                                                                                                                                    |
| 4   | Permissions rework         | **ALL of it (Phase 0 → 1 → 2 → 3), built strictly IN ORDER.**                                                                                                                                                                                                |
| 5   | Account recovery           | **Per recommendation** — org password reset first (operational-critical), then the rest.                                                                                                                                                                     |
| 6   | Provider console stubs     | **Per recommendation** — org-users mgmt first, BUT the whole provider-console block goes **at the END** of the queue ("everything at the end").                                                                                                              |
| 7   | Project-form Gate-6 schema | Per recommendation (one bundled Gate-6 proposal). **+ NEW future vision:** a configurable **FORM-BUILDER** — the form we built is the DEFAULT; an org can create its own forms / define which fields it wants (modular + generic). Captured as Epic F below. |

## 2. Build queue — STRICT ORDER

### P0 — gap-hunt findings, TRIAGED by owner (2026-06-09)

> Owner triage: (A core-signing) → relevant BEFORE prod, defer. (B prod-readiness)
> → set aside the prod ENVIRONMENT, BUILD the rest (modular/generic/SOLID so future
> hardening won't break things). (C compliance) → I build the CODE parts, owner
> handles legal/process. Build the "BUILD NOW" items professionally; SOLID at every step.

**🟢 BUILD NOW (owner approved — code, SOLID/modular):**

- [ ] **P0.B1 File-upload AV/malware scan** — owners upload → residents download; only mime-allowlist + size today, NO content scan. Add ClamAV / R2-event-driven scan via a pluggable `IFileScanProvider` (NoopScan in dev, real in prod) before a doc is markable downloadable. SOLID: interface-driven, swappable.
- [ ] **P0.B2 Monitoring / alerting / breach-detection hooks** — beyond Sentry capture: uptime/heartbeat, alert thresholds, and an audit-log-fed anomaly/breach-detection seam (pluggable) that can feed the notification duty. Metrics seam (the existing `TODO(metrics)`).
- [ ] **P0.B3 Backups / DR capability + runbook** — document + (where code) wire a tested Neon PITR/restore story; replace the `backups` provider stub with a real read-only status surface.
- [ ] **P0.C1 Data-subject ERASURE (hard-delete) + subject-access** — add a real, audited per-individual erasure (right-to-be-forgotten) + a data-subject-access export, beyond soft-delete. PII-encryption-aware. Gate-6 (touches owners/PII) → security-review.
- [ ] **P0.C2 Consent / privacy-notice capture** — record a resident's PII-processing notice/consent trail (lawful basis). Generic/modular so notice text + versions are configurable.
- [ ] **P0.C3 Audit-log retention enforcement** — an enforced ≥24-month policy (Israeli high-tier reg) instead of unbounded growth; a retention job + documented window.

**🟡 DEFERRED to PRE-PRODUCTION (owner: "relevant before prod"):**

- [ ] P0.D1 Verify the resident SIGN flow on MOBILE / iOS Safari + a real end-to-end test (token → DB single-use → R2 preview → encrypted store → cert).
- [ ] P0.D2 Live SMS (Inforu) verification against a live account + staging/prod creds.
- [ ] P0.D3 Production environment (deploy config + CI deploy + all secrets incl. PII keys for staging/prod). **Owner: set aside for now.**

**🔵 OWNER / LEGAL (owner handles — not code):**

- [ ] P0.O1 e-signature validity decision (simple vs secure vs certified; Electronic Signature Law 2001) — **escalate to legal.**
- [ ] P0.O2 DB registration (רישום מאגר) · security officer (ממונה אבטחת מידע) · periodic external audit (24mo)+pentest · breach-notification runbook + legal contacts.

### NOW — housekeeping (small, do first, unblocks the rest)

- [x] **H1. Fix #325 CI** ✅ DONE 2026-06-09 — root cause was api-doc drift (`docs/09-api-reference.generated.md` missing the new `signatureMilestones` field); regenerated + pushed (9188ae8); `gen-api-docs --check` + full build now pass.
- [ ] **H2. Decision 1 — org-configurable consent threshold in Settings.** Surface the existing `ConsentSettings` (org-settings) in the Settings UI; if no UI section exists, create it. Default stays 66; per-project override stays. (FE + maybe a thin settings wire — likely NOT Gate-6 since the schema exists.)
- [ ] **H3. Commit the 3 planning docs** (this roadmap + PLAN-account-recovery + PLAN-provider-console) so they persist + are reviewable.

### P1 — Account recovery (Decision 5) — operational-critical

- [ ] **R0.1 Org self-service password reset** (the single most critical operational gap). `password_reset_tokens` table + `forgot-password`/`reset-password` endpoints + FE; OWASP-aligned; purge sessions on reset. **Gate-2/6 + security-review.**
- [ ] R0.2 Provider peer-disable endpoint (set `disabledAt` + revoke sessions).
- [ ] R0.3 Break-glass runbook (process, no code).
- [ ] R1 ≥2-Owner posture (`assertNotLastOwner`) + re-provision-into-existing-org / `org.transfer_ownership` endpoint + bulk reassign on offboarding.

### P2 — Permissions model (Decision 4) — ALL, IN ORDER

- [ ] **Phase 0** — consolidate to single source of truth, **ZERO behavior change** (kill residual `user.role` branching; delete org `policy.ts` / regenerate oracle; stop trusting JWT role). Shadow-equivalence-pinned. _(Also fix the stale "NOT YET WIRED" docblock in `permission.service.ts`.)_
- [ ] **Phase 1** — custom **permission GROUPS** (org-owned roles): admin API + builder UI; wire `canAssignRole`; built-in 6 stay locked. Schema already exists.
- [ ] **Phase 2** — per-user **surgical override** (`permission_overrides` table, deny>grant>group-union>default) + members matrix/overrides UI. **Gate-6.**
- [ ] **Phase 3** — provider-tier parity (same engine shape, separate tier/instance).

### P3 — Project-form Gate-6 schema bundle (Decision 7)

- [ ] One bundled Gate-6 migration: `developer`/יזם, `unit_ratio` (יחס תמורה), `relocation_terms`, and a future-proof project-type enum value (post-תמ"א-38 / חלופת שקד). Plus parcel-provenance fields (for the future official-form import).

### P4 — Provider console (Decision 6) — at the END

- [ ] org-users management (`GET /provider/tenants/:id/users`, PII-masked, + FE) — first.
- [ ] customer-visible **Access Transparency** (org Manager sees "EMAPP staff accessed your org"). Governance quick-win.
- [ ] provider sub-roles (`provider_viewer`/billing) + segregation of duties.
- [ ] platform settings / feature-flags screen.
- [ ] JIT / time-boxed per-tenant access (ZSP growth).
- [ ] DEFER: billing/plans/support/integrations/backups (net-new domain models).

## 3. Epic F — Configurable Form-Builder (Decision 7 future vision)

> Owner's modular/generic vision: the default project/details forms ship built-in;
> an org can create its OWN forms or configure which fields appear. This is a
> large, separate epic (a per-org form/field schema + a builder UI + dynamic
> rendering + validation). DESIGN FIRST (Gate-2 — touches the data model deeply).
> Sequence AFTER the P1-P4 work unless the owner re-prioritizes. Capture as a
> future design task; do not start building without a dedicated design + sign-off.

## 4. Parallel / always-on

- Per-merge: keep CI green; security-review every auth/PII/Gate-6 diff; owner merges Gate-6.
- Pending owner inputs: 66-vs-67 final legal confirm (stored as 66); merge order (#325→#326); GitGuardian dashboard resolution for #317/#309.
- Small: duplicate `settings` i18n key (task chip); document "ghost" UX error; `permission.service.ts` stale docblock (fold into Phase 0).
