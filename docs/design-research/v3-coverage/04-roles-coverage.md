# 04 — Roles × Surface coverage audit (v3)

> **Dimension:** every role × surface across the 6 MVP roles (Manager, Agent,
> Viewer, Contractor, Tenant, Provider-Admin).
> **Method:** exhaustive enumeration from real code (`git ls-files` over the 66
> `page.tsx` route surfaces + the BE policy/permission/role catalogs + the 3
> external portals + the 4 tier layouts), each cross-checked against
> `docs/design-research/v2/00-MASTER-PLAN-V2.md` and its 8 expert docs + 3
> critiques. Status ∈ {COVERED, CHANGED, AS-IS-OK, GAP}.
> **Author:** v3 coverage council, 2026-06-18. READ-ONLY.

---

## GAP SUMMARY (ranked by impact on the one-shot-implementation goal)

The single structural finding: **the council explicitly scoped the redesign to
the org `(dashboard)` tier — i.e. 3 of the 6 roles (Manager, Agent, Viewer) —
and declared the other 3 roles' surfaces "separate IAs touched only at the
seams"** (`07-frontend-architecture.md:17-20`, `03-information-architecture.md:485-491`).
The completeness critic confirms the panel "scoped itself to ~10 of ~64 routes"
(`CRITIQUE-completeness.md:450`). For an *end-to-end, plan-once* mandate this is
the largest coverage hole: 3 entire role-surfaces are either un-redesigned, or
demoted to a P1/P2 backlog the master roadmap never sequences.

| # | GAP | Role(s) | Impact | Evidence |
|---|---|---|---|---|
| **G1** | **Provider-Admin tier is ENTIRELY ABSENT from the master plan.** The string "provider" appears 0 times in `00-MASTER-PLAN-V2.md`. 8 wired pages (`/provider/*`) + a dedicated `PCSidebar` (14 items, 4 groups) get neither a token re-skin slice, a North-Star pass, nor a guardrail. The plan's own §3.5 re-skin scope (35 files / 79 leaks) **excludes the entire provider subtree** → the new class-name guard ratchets from a false floor and these surfaces re-rot. | Provider-Admin | **CRITICAL** — a whole tier ships un-redesigned; visual inconsistency + leak-guard hole | `00-MASTER-PLAN-V2.md` (grep "provider"=0 in body); `pc-sidebar.tsx:99-121`; 8 pages under `provider/` |
| **G2** | **The known half-built Provider operator console is never folded in.** `PROVIDER-ADMIN-AUDIT.md` documents that the entire account-recovery half (reset/unlock a tenant user, reset MFA, resend invite, deactivate, impersonate, cross-tenant person search, provider-team mgmt) is missing at *every* layer — yet the redesign plan does not reference this audit or schedule any of its P0 items. A "plan once, close everything" pass that ignores a self-identified half-built tier guarantees mid-implementation discovery. | Provider-Admin | **CRITICAL** — the owner's explicit fear (discover-missing-mid-build) materialises here | `PROVIDER-ADMIN-AUDIT.md` §5 P0; plan never cites it |
| **G3** | **Contractor share view is demoted to a P1 backlog item (C7), not a sequenced slice.** It is the יזם's primary *external* deliverable, confirmed to carry `StatusBadge` + inline `var(--navy-*)` leaks (`contractor/share/page.tsx:102,118,126`) and to drop the BE lifecycle status. The plan lists it in "Wave 4 — completeness surfaces" but gives no wave/gate/owner-priority slot — it floats. | Contractor | **HIGH** — external-facing, on the leak path, in the re-skin baseline gap | `00-MASTER-PLAN-V2.md:375-377` C7; `CRITIQUE-completeness.md:439` |
| **G4** | **Tenant portal + tenant-OTP login are under-covered.** The whole `(tenant)` surface (`/portal` 770 lines + `/tenant/login` OTP) is the counterparty's experience for a *less* technical user than the יזם, yet it appears only inside C11 ("Net analysis, P2") bundled with calendar/concurrency. It carries the SAME `StatusBadge`/`var(--navy-*)` token leaks the re-skin must fix (`portal/page.tsx:165,277,332,421,549`) but is outside the §3.5 baseline. | Tenant | **HIGH** — re-skin will visibly skip a real signed-in surface; OTP friction stalls the whole signature mission | `portal/page.tsx`; `CRITIQUE-completeness.md:411-414,443` C11 |
| **G5** | **Viewer role's home is broken and the plan's home rewrite (E2.1) only converges Agent.** `(dashboard)/page.tsx:33-37` routes `agent`→AgentHome else→ManagerHome — so a **Viewer gets ManagerHome, which reads `GET /org/stats`** that the Viewer role lacks (`system-roles.ts:115-118` excludes `stats.`/governance reads) → "—" everywhere. E2.1 says "converge AgentHome onto the same ActionCard" but never names the Viewer; the Viewer's read-only mission-control is undesigned. | Viewer | **HIGH** — a real role lands on a dead/empty home today and after the rewrite | `(dashboard)/page.tsx:33-37`; `system-roles.ts:109-118`; `00-MASTER-PLAN-V2.md:339` |
| **G6** | **Public signer `/sign/[token]` is excluded but is the literal signature-capture surface** the whole product exists to feed. It is locale-less, token-only, and carries its own un-tokenized inline styles + a basis/consent UX (`sign/[token]/page.tsx`). The plan's §6.1 consent-basis rule and C1 print-of-record both touch what the resident signs, but the signer screen itself gets no re-skin slice. | Tenant/public counterparty | **MEDIUM** — the moment of legal commitment ships visually divergent from the redesigned app | `sign/[token]/page.tsx`; `07:19` (declared out of scope) |
| **G7** | **Agent capability-gating UX is correct in code but the plan never re-validates it after the nav 14→5 + board-first moves.** An agent's effective set strips manager-only writes + capability-OFF writes (`agent-effective-permissions.ts:56-94`). The board-first project page promotes campaign-send/export/parcel-setup into tabs; the plan asserts gating "carries over verbatim" (`03:481-483`) but provides no per-control re-test matrix for the agent's *partial* capability matrix (e.g. an agent with `manage_signatures` OFF must still not see the promoted campaign-send). | Agent | **MEDIUM** — regression risk: a promoted control may render for an agent who 403s on click | `agent-effective-permissions.ts`; `03:480-483` |
| **G8** | **`/messages` (team chat) is demoted to the topbar cluster but is an ACTIVE owner-requested epic** (MEMORY: team-messaging epic). The plan treats it as "orthogonal to the signature mission" (`00:77`) and gives it no role-surface design — yet it is participation-RLS-gated across all org roles and is mid-build. Demoting an in-flight feature into an undesigned topbar icon risks shipping a half-styled surface. | Manager/Agent/Viewer | **MEDIUM** — in-flight feature gets no design home | `00-MASTER-PLAN-V2.md:77`; `messages/page.tsx` |
| **G9** | **`external_read` system role exists in the catalog but has no FE surface mapped.** `system-roles.ts:120-132` defines External-Read (projects/buildings/apartments/documents/signature read, no PII) — the contractor's *intended* permission backing — but the plan never reconciles whether the contractor share view consumes this role or the bespoke `contractor_access_token` cookie path. Ambiguity = implementation guesswork. | Contractor | **LOW-MEDIUM** — role/surface binding unspecified | `system-roles.ts:120-132`; `contractor/share/page.tsx:42-61` |

**Bottom line for the one-shot goal:** the plan is exhaustive for Manager (and
largely Agent), thin for Viewer, and effectively silent for Contractor, Tenant,
and Provider-Admin. Three of six roles will be discovered mid-build unless G1–G6
are folded in now.

---

## INVENTORY — the role model (BE source of truth)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Org `Role` enum manager/agent/viewer | `policy.ts:15` | coarse D.17 role gating | AS-IS-OK | plan keeps gating in guard+middleware, never nav (`03:464-483`) |
| `POLICY` matrix (17 resources × 4 actions) | `policy.ts:51-126` | the authoritative coarse role grid | AS-IS-OK | unchanged; plan correctly leaves enforcement untouched |
| `PROVIDER_POLICY` (provider tier, read/write) | `policy.ts:166-172` | provider-tier authz, deliberately separate | **GAP (G1)** | plan never references the provider tier at all |
| 6 SYSTEM_ROLES (owner/admin/manager/agent/viewer/external_read) | `system-roles.ts:134-175` | the enterprise IAM role definitions | CHANGED-partial | plan touches manager/agent surfaces; owner/admin/external_read/viewer under-addressed (G5,G9) |
| `external_read` role def | `system-roles.ts:120-132` | external stakeholder read subset, no PII | **GAP (G9)** | not bound to any FE surface in the plan |
| Permission catalog (62 perms) | `permissions.ts:26-114` | atomic grantable actions | AS-IS-OK | plan gates on these via `useHasPermission`, unchanged |
| `effectiveAgentPermissions` (role ∧ capability − mgr-only) | `agent-effective-permissions.ts:84-94` | agent's real effective set | **GAP (G7)** | plan asserts gating carries over but gives no agent re-test matrix |
| `usePermissions`/`useHasPermission` (FE gate) | `use-permissions.ts:37-58` | the single FE permission read | COVERED | plan explicitly relies on it (`03:472-483`) |
| `PermissionGate` wrapper | `permission-gate.tsx:23-35` | declarative subtree gate | COVERED | reused by plan's hero components |
| AuthorizationGuard (org) | `authorization.guard.ts` | central coarse enforcement | AS-IS-OK | plan keeps it authoritative |
| ProviderAuthorizationGuard | `provider-authorization.guard.ts` | provider-tier enforcement | **GAP (G1)** | unmentioned |

## INVENTORY — tier layouts / sidebars (the role-surface entry points)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Dashboard layout tier-branch (org→Sidebar, provider→PCSidebar) | `(dashboard)/layout.tsx:42-55` | mounts the right nav per tier | CHANGED (org half) / **GAP (provider half, G1)** | plan reskins org Sidebar only |
| Org `Sidebar` 14 items + 4 perm gates | `sidebar.tsx:113-145` | org nav, gates owners/members/audit/settings | **CHANGED** | plan's headline IA move: 14→5 + Admin group (`00:63-81`) |
| Provider `PCSidebar` 14 items / 4 groups / 7 stubs | `pc-sidebar.tsx:99-121` | provider console nav | **GAP (G1)** | no re-skin/IA slice; plan's "16 nav" claim (`03:486`) is stale vs real 14 |
| Contractor layout (tier gate) | `(contractor)/layout.tsx` | contractor cookie tier boundary | AS-IS-OK (gate) / **GAP (skin, G3)** | gate untouched; view un-reskinned |
| Tenant layout (tier gate) | `(tenant)/layout.tsx` | tenant cookie tier boundary | AS-IS-OK (gate) / **GAP (skin, G4)** | gate untouched; portal un-reskinned |
| Sign layout (public, locale-less) | `sign/layout.tsx` | public signer chrome | AS-IS-OK (gate) / **GAP (skin, G6)** | excluded from re-skin |
| Role-aware home branch | `(dashboard)/page.tsx:30-37` | agent→AgentHome else ManagerHome | **GAP (G5)** | viewer falls to ManagerHome (org/stats it can't read) |

## INVENTORY — Manager surface (Tier-1 full; the plan's focus)

The Manager reaches all 60 `(dashboard)` routes. Sampled the load-bearing ones:

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Manager home (KPI grid + calendar stub) | `manager-home.tsx:115-139` | org dashboard | **CHANGED** | E2.1 deletes stub, converts to mission-control (`00:339`) |
| Projects list | `projects/page.tsx` + `projects-list.client.tsx` | full project power | **CHANGED** | E2-list: enrich rows, sort-by-distance (`00:342`) |
| Project detail (tabs, board in tab 4) | `projects/[id]/project-detail.client.tsx:79` | the spine | **CHANGED** | E2.2-S1/S3 board-first (`00:330,340`) |
| Project new wizard (1468 lines) | `projects/new/page.tsx` | first deep interaction | **CHANGED (C5)** | folded as completeness C5 P1 (`00:373-374`) |
| Owners list/detail/new/ownerships | `owners/*`, `apartments/[id]/ownerships/page.tsx` | person axis + PII | COVERED | owners dossier is plan's person-axis (`00:55-56`); reveal-PII gated |
| Buildings/apartments routes | `buildings/*`, `apartments/*` | structure drill-down | COVERED | become drill-downs from Structure tab (`00:102-103`) |
| Documents list/new/detail | `documents/*` | doc library | **CHANGED** | demoted to project tab + global library (`00:74`) |
| Signature-requests list/new/detail | `signature-requests/*` | campaign surface | **CHANGED** | demoted to board/project tab (`00:74`) |
| Tasks list/new/detail | `tasks/*` | task mgmt | **CHANGED** | spine item + Activity tab; dual-surface risk flagged R3 (`03:529`) |
| Notes list/new/detail | `notes/*` | activity log | **CHANGED** | demoted to Activity tab + owner dossier (`00:76`) |
| Contractors list/new/detail | `contractors/*` | address book | **CHANGED** | demoted to project Access tab (`00:76`) |
| Imports flow (list/new/[id]/mapping/errors) | `imports/*` | bulk ingest + live SSE | **CHANGED (C8)** | re-skin + SSE reconciliation, completeness C8 (`00:378-382`) |
| Members list/new/detail | `members/*` | org admin | **CHANGED** | collapsed into Admin group (`00:79`) |
| Settings + roles + sub-configs | `settings/*` (consent/branding/limits/localization/notifications), `settings/roles/page.tsx` | org governance | **CHANGED** | Admin group; per-org branding falls out of tokens (`00:153`) but role-config screen un-detailed |
| Audit log | `audit/page.tsx` | governance read | **CHANGED** | Admin group (`00:79`) |
| Messages (team chat) | `messages/page.tsx` | team chat (active epic) | **GAP (G8)** | demoted to topbar, no design |
| Notifications | `notifications/page.tsx` | notif center | **CHANGED** | redundant nav line dropped; bell stays (`00:78`) |

## INVENTORY — Agent surface (Tier-1 scoped)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Agent home (5 ranked items, HOME_LIMIT) | `agent-home.tsx` | scoped triage | COVERED | the plan's *structural precedent* for ActionCard (`00:113-115`) |
| Agent token leaks (~15 inline `var(--)` sites) | `agent-home.tsx` | — | **CHANGED** | plan flags clean-before-promote (Tension 7, `00:438-441`) |
| Agent effective-perm filtering | `agent-effective-permissions.ts:27-94` | capability gating | **GAP (G7)** | no post-board-first re-test matrix |
| Owners nav gated on `owners.read` (capability) | `sidebar.tsx:104,119-121` | agent w/o view_owners hides Owners | AS-IS-OK | plan keeps this gate verbatim (`03:477-478`) |
| Agent scoped lists (projects/tasks/docs/notes) | per-service RLS+JOIN | assigned-project scope | AS-IS-OK | plan relies on existing agent-scope; B1 pulse adds agent-scope CTE (`00:251`) |

## INVENTORY — Viewer surface (Tier-1 read-only)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Viewer role def (reads only, PII masked, no governance reads) | `system-roles.ts:109-118` | least-priv read | AS-IS-OK | role correct |
| Viewer home (falls to ManagerHome) | `(dashboard)/page.tsx:35-37` | dashboard | **GAP (G5)** | ManagerHome reads org/stats viewer can't → "—" |
| Viewer "no create CTAs" | `projects-list.client.tsx:63,191` | read-only UX | COVERED | plan re-tests this in per-role smoke (`03:512-514`) |
| Viewer Admin-group absence (no members/audit/settings) | `sidebar.tsx:137-145` | governance hidden | COVERED | gates carry over (`03:476-478`) |

## INVENTORY — Contractor surface (Tier-2 external, share-based)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Contractor share view | `contractor/share/page.tsx:42-198` | external read deliverable | **GAP (G3)** | C7 backlog, no wave/gate slot |
| Inline `var(--navy-*)`/`StatusBadge` leaks | `contractor/share/page.tsx:102,118,126,152` | — | **GAP (G3)** | excluded from §3.5 baseline (`00:213-216` acknowledges but doesn't sequence) |
| Per-section 403-degrade ("not shared") | `contractor/share/page.tsx:38-41,113,169` | graceful perms | AS-IS-OK | good pattern; plan doesn't touch |
| Dropped BE lifecycle status → opaque `invalidLink` | `contractor/share/page.tsx:77-85` | status bug | **GAP (G3)** | completeness flags it (`CRITIQUE-completeness.md:439`); not scheduled |
| Contractor JSONB perms (signatures/documents toggles) | `contractor/share/page.tsx:113,169` | share-scoped reads | AS-IS-OK | wire-driven; untouched |

## INVENTORY — Tenant surface (Tier-2 resident, SMS OTP)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Tenant portal (hero/apartment/identity/progress/docs/sigs) | `portal/page.tsx:98-598` | resident self-service | **GAP (G4)** | only in C11 P2 bundle |
| Tenant OTP login | `tenant/login/page.tsx` | resident first touch | **GAP (G4)** | G-TENANT-OTP, never designed (`CRITIQUE-completeness.md:411-414`) |
| Portal token leaks (`var(--navy-*)`, StatusBadge, hardcoded #fff/#22c55e) | `portal/page.tsx:165,202,277,332,421,549` | — | **GAP (G4)** | outside re-skin baseline |
| Portal resend-signature (own record) | `portal/page.tsx:561-585` | tenant self-resend | AS-IS-OK | M2 chase loop notes tenant resendForOwner rotates clock (`00:341`) — acknowledged at seam |
| Own-PII masked display (D.47) | `portal/page.tsx:342-389` | tenant sees own masked PII | AS-IS-OK | correct; untouched |
| Email self-edit form (method=post) | `portal/page.tsx:670-755` | only self-editable field | AS-IS-OK | follows form DoD; untouched |

## INVENTORY — Public signer (the signature-capture surface)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Sign page (preview/canvas/consent/submit) | `sign/[token]/page.tsx:46-399` | resident signs | **GAP (G6)** | declared out of scope (`07:19`) |
| Explicit-consent gate (P0.C2) | `sign/[token]/page.tsx:108-116,336-365` | per-org consent | COVERED-adjacent | §6.1 consent-basis rule touches this conceptually but not the screen |
| Inline doc preview + new-tab fallback | `sign/[token]/page.tsx:292-326` | read-before-sign | AS-IS-OK | untouched |
| Anti-enumeration generic error | `sign/[token]/page.tsx:192-216` | security UX | AS-IS-OK | untouched |

## INVENTORY — Provider-Admin surface (Tier-3 operator)

| item | file:line | purpose | plan status | note |
|---|---|---|---|---|
| Provider dashboard home (one health dot) | `provider/page.tsx` | operator landing | **GAP (G1,G2)** | absent from plan; audit flags no platform metrics |
| Tenants list | `provider/tenants/page.tsx` | cross-tenant org list | **GAP (G1)** | un-reskinned |
| Tenant detail (suspend/reactivate) | `provider/tenants/[id]/page.tsx` | the only per-tenant actions | **GAP (G1)** | un-reskinned |
| Tenant users (read-only) | `provider/tenants/[id]/users/page.tsx` | masked roster | **GAP (G2)** | account-recovery actions missing entirely |
| Onboard | `provider/onboard/page.tsx` | create org + invite mgr | **GAP (G1)** | un-reskinned |
| Cross-tenant audit | `provider/audit/page.tsx` | forensic search | **GAP (G1)** | un-reskinned |
| Self-audit | `provider/audit/self/page.tsx` | provider team log | **GAP (G1)** | un-reskinned |
| System health | `provider/system-health/page.tsx` | gauges, no actions | **GAP (G2)** | no alert→action path |
| Backups (static doc) | `provider/backups/page.tsx` | DR posture | AS-IS-OK | intentionally static; not a design target |
| 7 padlocked stubs (plans/billing/support/roles/integrations/staff/settings) | `pc-sidebar.tsx:108-120` | honest future-work | AS-IS-OK | correctly placeholders; plan doesn't need to build them |
| Account-recovery toolkit (reset/unlock/MFA/resend/impersonate/person-search) | absent (no endpoint, no UI) | #1 operator task | **GAP (G2)** | `PROVIDER-ADMIN-AUDIT.md` P0; plan never schedules |

---

## Counts

- **Items inventoried:** ~70 (10 role-model + 7 tier-entry + ~18 Manager + 5 Agent
  + 4 Viewer + 5 Contractor + 6 Tenant + 4 Signer + 11 Provider).
- **COVERED:** ~14 · **CHANGED (in plan):** ~16 · **AS-IS-OK:** ~17 · **GAP:** ~23
  (clustered into 9 ranked gaps G1–G9).
- **Roles fully covered:** Manager (and Agent, modulo G7). **Under-covered:**
  Viewer (G5). **Effectively un-covered:** Contractor (G3,G9), Tenant (G4,G6),
  Provider-Admin (G1,G2).
