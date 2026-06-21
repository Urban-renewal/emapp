# EMAPP — Manual Browser Audit Checklist (exhaustive interactive-surface map)

> READ-ONLY map for a systematic per-role manual browser walk. Generated from
> `apps/web/src/app/**` + `src/middleware.ts` + `useHasPermission` gates.
> **MISSING = 0 is the goal.** Fill the `Status` column during the real-browser
> walk: ✅ works · ❌ broken · ⚠️ read-only / missing-capability · 🔒 intentional-stub.
>
> Citations are `file:line` relative to `apps/web/`.

## The 6 roles

| # | Role | Tier | Login surface | Token cookie |
|---|------|------|---------------|--------------|
| 1 | **Manager** | T1 org (full) | `/login` | `access_token` |
| 2 | **Agent** | T1 org (assigned projects, capability-gated) | `/login` | `access_token` |
| 3 | **Viewer** | T1 org (read-only) | `/login` | `access_token` |
| 4 | **Contractor** | T2 external (share-based, JSONB perms) | manager-issued share link (no self-login) | `contractor_access_token` |
| 5 | **Tenant** | T2 external (resident, SMS OTP, own record) | `/tenant/login` | `tenant_access_token` |
| 6 | **Provider Admin** | T3 (cross-tenant console, MFA) | `/provider/login` | `provider_access_token` |

The three org roles (Manager/Agent/Viewer) share ONE login form (`/login`) — the
BE derives the role; the same form serves all three. UI differences are driven
entirely by the `/me` effective-permission set (`useHasPermission`) — see the
[permission → role matrix](#permission--role-quick-reference) at the bottom.

---

## Coverage matrix (reachable? Y / N / partial)

Columns = top-level sections. Rows = roles. "partial" = section reachable but
key actions gated off for that role.

| Role \ Section | dashboard | projects | owners | buildings/apts | documents | sig-requests | tasks | notes | contractors | members | imports | audit | notifications | messages | settings | provider-console | public-sign | tenant-portal |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Manager**  | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | N | N¹ | N |
| **Agent**    | Y (AgentHome) | partial² | partial³ | partial⁴ | partial⁵ | partial⁶ | partial⁷ | partial⁸ | partial⁹ | N¹⁰ | partial¹¹ | N¹² | Y | Y | partial¹³ | N | N¹ | N |
| **Viewer**   | Y (ManagerHome, KPIs may show —) | partial(read) | partial(read)¹⁴ | partial(read) | partial(read) | partial(read) | partial(read) | partial(read) | Y(read) | N¹⁰ | N¹¹ | N¹² | Y | Y | partial¹³ | N | N¹ | N |
| **Contractor** | N | N | N | partial(read, structural)¹⁵ | partial(read)¹⁵ | N¹⁵ | N | N | N | N | N | N | N | N | N | N | N | N |
| **Tenant**   | N | N(own only) | N | N(own apt only) | partial(read)¹⁶ | partial(own)¹⁶ | N | N | N | N | N | N | N | N | partial(email edit)¹⁶ | N | Y¹ | Y |
| **Provider Admin** | Y(provider dash) | N | N | N | N | N | N | N | N | partial(masked)¹⁷ | N | Y(cross-tenant)¹⁷ | N | N | N(own console) | Y | N | N |

**Notes**
1. `/sign/[token]` is anonymous (JWT-bearer, no cookie). Any human with the SMS/WhatsApp link reaches it — it is "reachable" by the resident only in practice, but it's a public route, not role-gated.
2. Agent: projects list scoped to ASSIGNED projects (BE service-layer); no "New project" CTA unless `projects.create` (agents don't hold it by default).
3. Owners: Owners nav item + page appear ONLY if the agent's `view_owners` capability is ON (sidebar gates on `owners.read`).
4. Buildings/apartments: reachable via assigned projects; create CTAs gated on `buildings.create`/`apartments.create`.
5. Documents: create/upload gated on `documents.create`; download gated on `documents.download`.
6. Signature-requests: send/create gated on `signature_requests.send`; cancel on `signature_requests.cancel`.
7. Tasks: agent sees only tasks assigned to them (BE JOIN); create gated `tasks.create`; edit `tasks.update`.
8. Notes: read=ALL; create `notes.create`; edit/archive `notes.update`/`notes.archive` (BE additionally requires author-or-manager).
9. Contractors: read=ALL; create gated `contractors.create`; archive `contractors.archive`.
10. Members: Manager-only resource (BE 403s others). Sidebar hides the item unless `members.read`.
11. Imports: list reachable; upload/run gated on `imports.run`.
12. Audit: Manager-only (`audit.read`); sidebar hides the item, page renders access-denied otherwise.
13. Settings: page reachable for org tier; roles tab/page + per-user overrides gated on `roles.manage`; settings update gated on `org.settings.update`.
14. Viewer: PII reveal button NOT shown (gated on `/me.view_owner_pii`, which viewers never hold).
15. Contractor: each section (overview / documents / signatures) renders ONLY if the share's JSONB permission for it is ON; structural-only (no owner data ever).
16. Tenant portal: read-only except the email self-edit + the per-signature "resend" action.
17. Provider: members shown MASKED via `/provider/tenants/:id/users`; audit is the cross-tenant search, not the org `/audit`.

---

# Tier 1 — Org users (Manager / Agent / Viewer)

## Auth / public routes (no session required)

### `/login` — org login (Manager/Agent/Viewer) — `app/[locale]/(auth)/login/page.tsx`

| Element | Type | Expected behavior | Source (file:line) | Status |
|---|---|---|---|---|
| Email input | input | email field, `dir=ltr`, RHF + Zod | login/page.tsx:130 | |
| Password input | input | password field, masked | login/page.tsx:149 | |
| "התחבר" submit | button | POST `/auth/login`; on OK `router.replace('/<locale>')` + refresh; anti-enum generic error | login/page.tsx:170,52 | |
| "שכחת סיסמה?" link | link | → `/forgot-password` | login/page.tsx:182 | |
| "הרשמה" link | link | → `/signup` — **only rendered if `NEXT_PUBLIC_SIGNUP_ENABLED==='1'`** (🔒 off by default) | login/page.tsx:197 | |
| `<form method="post">` | form | DoD: no GET-fallback credential leak | login/page.tsx:120 | |

### `/signup` — org self-signup — `(auth)/signup/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| WHOLE PAGE | redirect | **🔒 redirects to `/login` unless `NEXT_PUBLIC_SIGNUP_ENABLED==='1'`** (off by default) | signup/page.tsx:27 | |
| org_name / name / email / password | inputs | RHF + Zod | signup/page.tsx:96-156 | |
| "צור חשבון" submit | button | POST `/auth/signup`; anti-enum (no email_taken) | signup/page.tsx:161,42 | |
| "התחברות" link | link | → `/login` | signup/page.tsx:168 | |

### `/forgot-password` — `(auth)/forgot-password/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Email input | input | RHF + Zod | forgot-password/page.tsx:76 | |
| Submit | button | `forgotPassword()`; ALWAYS generic "if exists we sent" notice (no oracle) | forgot-password/page.tsx:97,38 | |
| "חזרה להתחברות" link | link | → `/login` | forgot-password/page.tsx:108 | |

### `/reset-password?token=…` — `(auth)/reset-password/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| (token-less URL) | guard | shows "missing token" + "request new link" → `/forgot-password` | reset-password/page.tsx:108 | |
| token scrub | side-effect | `?token=` removed from URL on mount (SEC M-2) | reset-password/page.tsx:55 | |
| New password / confirm | inputs | client-only confirm match; only `{token,newPassword}` on wire | reset-password/page.tsx:148,167 | |
| Submit | button | `resetPassword()`; success → 1.2s delay → `/login`; anti-enum | reset-password/page.tsx:188,75 | |

### `/accept-invite/[token]` — member invite landing — `(auth)/accept-invite/[token]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Password / confirm | inputs | invitee sets own password (min 12); wire carries only `password` | accept-invite/page.tsx:117,135 | |
| Submit | button | `acceptInvite()`; success → 1.2s → `/login`; anti-enum `invalidInvite` | accept-invite/page.tsx:149,66 | |

## Dashboard chrome (every authenticated org page)

### Sidebar (org) — `(dashboard)/_components/sidebar.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Home | nav link | always → `/` | sidebar.tsx:114 | |
| Projects | nav link | always → `/projects` | sidebar.tsx:115 | |
| Owners | nav link | **only if `owners.read`** (agent: iff view_owners) → `/owners` | sidebar.tsx:119 | |
| Imports | nav link | always → `/imports` | sidebar.tsx:122 | |
| Documents | nav link | always → `/documents` | sidebar.tsx:123 | |
| Signature-requests | nav link | always → `/signature-requests` | sidebar.tsx:124 | |
| Notifications | nav link | always → `/notifications` | sidebar.tsx:130 | |
| Tasks | nav link | always → `/tasks` | sidebar.tsx:131 | |
| Contractors | nav link | always → `/contractors` | sidebar.tsx:132 | |
| Notes | nav link | always → `/notes` | sidebar.tsx:133 | |
| Messages | nav link | always → `/messages` | sidebar.tsx:134 | |
| Members | nav link | **only if `members.read`** → `/members` | sidebar.tsx:137 | |
| Audit | nav link | **only if `audit.read`** → `/audit` | sidebar.tsx:140 | |
| Settings | nav link | **only if `org.settings.read`** → `/settings` | sidebar.tsx:143 | |
| Logout | button | tier-aware; org → `/auth/logout` + clears cookies → `/login` | sidebar.tsx:264 · logout-button.tsx:78 | |

### Topbar — `(dashboard)/_components/topbar.tsx` + `notifications-bell.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Org name label | display | leading; `<NameDisplay>` | topbar.tsx:46 | |
| Notifications bell | button | org tier only; toggle popover (5 recent) | topbar.tsx:51 · notifications-bell.tsx:70 | |
| Bell row link | link | → notification `n.link` (closes popover) | notifications-bell.tsx:183 | |
| Bell "הצג הכל"/"viewAll" | link | → `/notifications` | notifications-bell.tsx:120,203 | |

## Dashboard home `/` — `(dashboard)/page.tsx` (role-branched)

### ManagerHome (manager/viewer) — `_components/manager-home.tsx` + `home-actions.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| 4 KPI cards | display | `GET /org/stats`; falls back to "—" (agents 403 → AgentHome instead) | manager-home.tsx:94 | |
| "פרויקט חדש" CTA | link | **only if `projects.create`** → `/projects/new` | home-actions.tsx:31,27 | |
| WeekCalendar panel | display | **🔒 empty-state stub ("coming soon")** — Phase-2 deferred | manager-home.tsx:115 | |
| Conversations panel | client island | live recent threads (`HomeConversations`) → links to `/messages` | manager-home.tsx:155 | |

### AgentHome (role === 'agent') — `_components/agent-home.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| My projects list | links | scoped to assigned; rows → `/projects/[id]`; "viewAll" → `/projects` | agent-home.tsx:81,107 | |
| My tasks list | links | tasks assigned to me; rows → `/tasks/[id]`; "viewAll" → `/tasks` | agent-home.tsx:136,162 | |
| My notifications list | display | self-scoped recent; "viewAll" → `/notifications` | agent-home.tsx:201 | |

## Projects

### `/projects` — list — `projects/projects-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Search input | input | client-side filter on name/type/status | projects-list.client.tsx:137 | |
| Cards/Table view toggle | buttons (tablist) | switch render mode | projects-list.client.tsx:155,172 | |
| "פרויקט חדש" CTA | link | **only if `projects.create`** → `/projects/new` | projects-list.client.tsx:191,63 | |
| Project card / table row | link | → `/projects/[id]` (table row uses `window.location.assign`) | projects-list.client.tsx:214,309 | |
| "הבא" / next | button | cursor pagination | projects-list.client.tsx:343 | |
| "חזרה לעמוד ראשון" | button | reset cursor | projects-list.client.tsx:348 | |
| access-denied state | display | terminal, NO retry (403 `projects.read`) | projects-list.client.tsx:94 | |

### `/projects/new` — 3-step wizard — `projects/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Step 1: name / type / consent% | inputs/select | name required; type drives building cap + consent default | new/page.tsx:654,669,696 | |
| Milestones: suggest / add / remove rows | buttons | seed [25,50,target]; max 10; auto-sort on blur | new/page.tsx:723,780,769 | |
| Renewal fieldset (developer/תמורה/relocation/parcel) | inputs | all optional; relocation only for demolish-rebuild types | new/page.tsx:807-1015 | |
| Step 2: add/remove building | buttons | capped by type (tama38_1=1, _2=2, pinui=20) | new/page.tsx:1287,1270 | |
| Step 2: add/remove section per building | buttons | kind-driven progressive disclosure; ≥1 per building | new/page.tsx:1257,1241 | |
| "הבא" / Next | button | per-step validation; disabled until hydrated | new/page.tsx:1455 | |
| "חזרה" / Back | button | step − 1 | new/page.tsx:1439 | |
| "ביטול" / Cancel | button | → `/projects` | new/page.tsx:1451 | |
| Step 3 "צור" / Submit | submit | POST `/projects`; double-fire guard; → `/projects/[id]` | new/page.tsx:1460,390 | |

### `/projects/[id]` — detail (4 tabs) — `projects/[id]/project-detail.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Excel export button | button | **only if `export.run`** → `GET /projects/:id/export?format=xlsx` (blob) | project-detail.client.tsx:159,72 | |
| Tabs: Tenants/Docs/Tasks/Dashboard | buttons (tablist) | switch panel | project-detail.client.tsx:237 | |
| Tenants tab CTA | link | → `/projects/[id]/buildings` | project-detail.client.tsx:268 | |
| Docs tab CTAs | links | → `/documents`, `/signature-requests` | project-detail.client.tsx:283 | |
| Tasks tab CTA | link | → `/tasks` | project-detail.client.tsx:294 | |
| Dashboard: signature-progress board | display | read-only "X/Y agreed · Z% · target W%" | project-detail.client.tsx:306 | |
| Dashboard: signature-progress apartments drill-down | expandable | lazy per-apartment counts (no PII) | project-detail.client.tsx:310 | |
| Dashboard: project document upload | form | in-context upload (`SignatureProgressBoard` sibling) | project-detail.client.tsx:315 | |
| Dashboard: signature campaign action | button | fan out doc to all owners (`signature_requests.send`) | project-detail.client.tsx:319 | |
| Dashboard: parcel-setup section | flow | **only if `buildings.create`**; preview/confirm builds buildings+apts | project-detail.client.tsx:328,75 | |
| Buildings "ניהול" | link | → `/projects/[id]/buildings` | project-detail.client.tsx:375 | |
| Assignments "ניהול" | link | → `/projects/[id]/assignments` | project-detail.client.tsx:389 | |
| Shares "ניהול" | link | → `/projects/[id]/shares` | project-detail.client.tsx:403 | |
| Archive | button | **only if `projects.archive`**; `window.confirm` → `/projects` | project-detail.client.tsx:413,71 | |
| not-found state | display | "back to list" → `/projects` | project-detail.client.tsx:88 | |

### `/projects/[id]/buildings` — `projects/[id]/buildings/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "בניין חדש" CTA | link | **only if `buildings.create`** → `…/buildings/new` | buildings/page.tsx:44,21 | |
| back link | link | → `/projects/[id]` | buildings/page.tsx:51 | |
| Building row | link | → `/buildings/[id]` | buildings/page.tsx:62 | |
| next / reset | buttons | pagination | buildings/page.tsx:87,92 | |

### `/projects/[id]/buildings/new` — `…/buildings/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| address/city/block/parcel/subparcel/notes | inputs | RHF+Zod | buildings/new/page.tsx:54-130 | |
| Cancel / Submit | buttons | submit POST → `/buildings/[id]` | buildings/new/page.tsx:135,138 | |

### `/projects/[id]/assignments` — `projects/[id]/assignments/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Assign form (user select + role select + submit) | form | **only if `project_assignments.manage` AND members side-load OK**; POST assignment | assignments/page.tsx:167,171 | |
| "שייך" / Assign | submit | duplicate→`assignment_exists` mapped | assignments/page.tsx:217,132 | |
| Unassign per row | button | **only if `project_assignments.manage` + active**; `window.confirm` | assignments/page.tsx:276,145 | |
| back-to-project | button | → `/projects/[id]` | assignments/page.tsx:159 | |
| pagination + retry | buttons | ListPageShell | assignments/page.tsx:227 | |

### `/projects/[id]/shares` — contractor shares — `projects/[id]/shares/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Contractor select | select | eligible = non-archived, not-already-granted | shares/page.tsx:129 | |
| Permission toggles (overview/documents+download/signatures) | checkboxes | composes `SharePermissions` | shares/page.tsx:160-196 | |
| "הענק" / Grant | submit | POST share; `share_exists`/`forbidden` mapped | shares/page.tsx:204,85 | |
| "קישור שיתוף" / share-link | button | mint token; shows URL textarea ONCE (credential) | shares/page.tsx:251,63 | |
| "בטל" / Revoke | button | `window.confirm` → DELETE share | shares/page.tsx:260,98 | |
| Minted link textarea | readonly | shown once for copy + warning | shares/page.tsx:278 | |
| back-to-project | button | → `/projects/[id]` | shares/page.tsx:117 | |

## Owners

### `/owners` — list — `owners/owners-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "צור" / create CTA | link | **only if `owners.create`** → `/owners/new` | owners-list.client.tsx:47,30 | |
| Active/Archived tabs | buttons (tablist) | toggle archived view; resets cursor | owners-list.client.tsx:59 | |
| Owner name / "צפה" | links | → `/owners/[id]` | owners-list.client.tsx:125,161 | |
| Masked PII columns | display | `nationalIdMasked` · `phoneMasked` (never cleartext in list) | owners-list.client.tsx:139 | |
| pagination/retry | ListPageShell | | owners-list.client.tsx:81 | |

### `/owners/new` — `owners/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| name / national_id / phone / email / notes | inputs | `method="post"` (PII — no GET leak); national_id maxLength 9 | owners/new/page.tsx:59-139 | |
| Cancel / Submit | buttons | POST `/owners`; `owner_exists`→field error → `/owners/[id]` | owners/new/page.tsx:144,147,41 | |

### `/owners/[id]` — dossier — `owners/[id]/owner-detail.client.tsx` + `owner-pii-reveal.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Archive ("ארכוב") | button | **only if `owners.archive`** + not archived; `window.confirm` → `/owners` | owner-detail.client.tsx:157,75 | |
| **Reveal PII** ("הצג") | button | **only if `/me.view_owner_pii`** (manager always / agent iff cap / viewer never); POST `/owners/:id/reveal-pii` (audited); cleartext transient | owner-pii-reveal.tsx:99,57 | |
| Hide PII | button | clears cleartext | owner-pii-reveal.tsx:110,71 | |
| back-to-list | link | → `/owners` | owner-detail.client.tsx:121 | |
| Projects-tied rows | links | → `/projects/[id]` | owner-detail.client.tsx:251 | |
| ⚠️ quick-actions row | (removed) | the WhatsApp/send/note/task placeholder row was removed (ship-or-hide); NOT a bug | owner-detail.client.tsx:270 | |

## Buildings / Apartments

### `/buildings/[id]` — detail — `buildings/[id]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Archive | button | not-archived only; `window.confirm` → `…/buildings` (no permission gate here — BE authoritative) | buildings/[id]/page.tsx:76,39 | |
| back link | link | → `/projects/[projectId]/buildings` | buildings/[id]/page.tsx:54 | |
| Apartments "ניהול" | link | → `/buildings/[id]/apartments` | buildings/[id]/page.tsx:96 | |

### `/buildings/[id]/apartments` — list — `buildings/[id]/apartments/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "דירה חדשה" CTA | link | **only if `apartments.create`** → `…/apartments/new` | apartments/page.tsx:50,23 | |
| back link | link | → `/buildings/[id]` | apartments/page.tsx:57 | |
| Apartment row | link | → `/apartments/[id]` | apartments/page.tsx:68 | |
| next/reset | buttons | pagination | apartments/page.tsx:96,101 | |

### `/buildings/[id]/apartments/new` — `…/apartments/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| number/unitType/floor/rooms/sizeSqm/status/notes | inputs/selects | rooms hidden for shop/office (D.39 disclosure) | apartments/new/page.tsx:84-194 | |
| Cancel / Submit | buttons | POST → `/apartments/[id]` | apartments/new/page.tsx:199,202 | |

### `/apartments/[id]` — detail — `apartments/[id]/page.tsx` + `_components/tabu-review-section.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Archive | button | **only if `apartments.archive`** + not archived; `window.confirm` | apartments/[id]/page.tsx:124,39 | |
| Status select + "שמור" | select + button | **only if `apartments.update`**; PATCH status | apartments/[id]/page.tsx:138,151,38 | |
| Ownerships "ניהול" | link | → `/apartments/[id]/ownerships` | apartments/[id]/page.tsx:192 | |
| Tabu review section | flow | **only if `apartments.update`**: create extraction → run parse → review rows (step-up PII unlock) → edit row → confirm-write ownerships | tabu-review-section.tsx (mounted at apartments/[id]/page.tsx:200) | |
| back link | link | → `/buildings/[id]/apartments` | apartments/[id]/page.tsx:98 | |

### `/apartments/[id]/ownerships` — `apartments/[id]/ownerships/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Per-row owner select + % input + remove | row controls | sum-to-100 invariant; dupe detection | ownerships/page.tsx:167,181,192 | |
| "addRow" | button | append owner row | ownerships/page.tsx:208 | |
| "+ אדם חדש" InlineCreateOwner | toggle form | inline `/owners` POST (PII; `method=post`) → adds row | ownerships/page.tsx:211,334 | |
| Cancel / Save | buttons | PUT ownerships (atomic set-replace); `ownership_sum_invalid` mapped | ownerships/page.tsx:243,246,109 | |

### `/apartments` (bare) — `apartments/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| WHOLE PAGE | redirect | no global list — `redirect('/projects')` (intentional) | apartments/page.tsx:13 | |

## Documents

### `/documents` — list — `documents/documents-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Search input | input | client-side filter name/type | documents-list.client.tsx:107 | |
| Cards/Table toggle | buttons | view mode | documents-list.client.tsx:125,142 | |
| Active/Archived tabs | buttons | toggle archived | documents-list.client.tsx:169 | |
| "מסמכי חתימה" entry | link | → `/signature-requests` | documents-list.client.tsx:193 | |
| "העלאת מסמך" CTA | link | **only if `documents.create`** → `/documents/new` | documents-list.client.tsx:199,59 | |
| Doc card / row | link | → `/documents/[id]` | documents-list.client.tsx:220,262 | |
| next/reset | buttons | pagination | documents-list.client.tsx:303,308 | |

### `/documents/new` — upload — `documents/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Type select | select | DocumentType enum | documents/new/page.tsx:108 | |
| File picker | input(file) | mime allow-list + 50MB ceiling (UX); `accept` list | documents/new/page.tsx:126,33 | |
| Cancel / "העלאה" | buttons | upload (content-path for sensitive); AV/integrity codes mapped → `/documents/[id]` | documents/new/page.tsx:144,147,51 | |

### `/documents/[id]` — detail — `documents/[id]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "צפה" / View (inline) | button | **only if `documents.download`** + not archived; presign/decrypt-stream open new tab; step-up unlock on 403 | documents/[id]/page.tsx:152,26,69 | |
| "הורד" / Download (attachment) | button | **only if `documents.download`** + not archived; save dialog / blob | documents/[id]/page.tsx:161 | |
| Archive | button | **only if `documents.archive`** + not archived; `window.confirm` → `/documents` | documents/[id]/page.tsx:170,27,116 | |
| step-up unlock modal | modal | OTP request→verify→retry on `pii_step_up_required` | documents/[id]/page.tsx:181 | |
| back-to-list | link | → `/documents` | documents/[id]/page.tsx:131 | |

## Signature requests

### `/signature-requests` — list — `signature-requests/signature-requests-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Status filter buttons (all/pending/signed/cancelled) | buttons | filter + reset cursor | sig-list.client.tsx:69 | |
| "צור" CTA | link | **only if `signature_requests.send`** → `/signature-requests/new` | sig-list.client.tsx:62,35 | |
| Request row | link | → `/signature-requests/[id]` | sig-list.client.tsx:91 | |
| next/reset | buttons | pagination | sig-list.client.tsx:120,125 | |

### `/signature-requests/new` — `signature-requests/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Document select | select | scoped owner select depends on this | sig/new/page.tsx:133 | |
| Owner select | select | scoped to doc's apartment owners (or all owners) | sig/new/page.tsx:158 | |
| Cancel / "צור" | buttons | POST; `pending_exists`/`recipient_not_associated` mapped | sig/new/page.tsx:189,55 | |
| (after create) sign-URL textarea | readonly | shown once | sig/new/page.tsx:97 | |
| "העתק" / Copy | button | clipboard copy of signUrl | sig/new/page.tsx:106,78 | |
| "צפה בבקשה" | button | → `/signature-requests/[id]` | sig/new/page.tsx:109 | |

### `/signature-requests/[id]` — detail — `signature-requests/[id]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "העתק קישור" / copy signing link | button | **only if `signature_requests.send` + pending**; retrieve link → clipboard (never rendered) | sig/[id]/page.tsx:154,42,85 | |
| "הורד חתום" / download signed | button | **only if `/me.view_owner_pii` + signed**; blob download | sig/[id]/page.tsx:163,35,64 | |
| "בטל" / Cancel | button | **only if `signature_requests.cancel` + cancellable**; `window.confirm` | sig/[id]/page.tsx:168,37,111 | |
| back-to-list | link | → `/signature-requests` | sig/[id]/page.tsx:133 | |

## Tasks

### `/tasks` — list — `tasks/tasks-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "צור" CTA | link | **only if `tasks.create`** → `/tasks/new` | tasks-list.client.tsx:42,33 | |
| Task row | link | → `/tasks/[id]` | tasks-list.client.tsx:69 | |
| ListPageShell pagination | buttons | | tasks-list.client.tsx:48 | |

### `/tasks/new` — `tasks/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| title / description / priority select | inputs | RHF+Zod | tasks/new/page.tsx:76,93,108 | |
| Cancel / "צור" | buttons | POST `/tasks`; `forbidden` mapped → `/tasks/[id]` | tasks/new/page.tsx:125,128,51 | |

### `/tasks/[id]` — detail — `tasks/[id]/task-detail.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Status select + description + "שמור" | form | **only if `tasks.update`** (else read-only view); PATCH | task-detail.client.tsx:223,270,67 | |
| Assignees list | display | read-only for all | task-detail.client.tsx:305 | |
| Remove assignee | button | **only if isManager** (`/members` 200 side-load); `window.confirm` | task-detail.client.tsx:330,171 | |
| Add-assignee form (select + "שייך") | form | **only if isManager + not archived** | task-detail.client.tsx:346,374,159 | |
| Archive | button | **only if isManager + not archived**; `window.confirm` → `/tasks` | task-detail.client.tsx:391,148 | |
| back-to-list | button | → `/tasks` | task-detail.client.tsx:211 | |

## Notes

### `/notes` — list — `notes/notes-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "צור" CTA | link | **only if `notes.create`** → `/notes/new` | notes-list.client.tsx:56,49 | |
| Note row | link | → `/notes/[id]` (pinned floats top) | notes-list.client.tsx:90 | |
| ListPageShell pagination | buttons | | notes-list.client.tsx:62 | |

### `/notes/new` — `notes/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| body textarea / pinned checkbox | inputs | RHF+Zod | notes/new/page.tsx:62,74 | |
| Cancel / "צור" | buttons | POST `/notes`; `forbidden` mapped → `/notes/[id]` | notes/new/page.tsx:83,86,43 | |

### `/notes/[id]` — detail — `notes/[id]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| body + pinned + "שמור" | form | **only if `notes.update`** (else read-only); PATCH (BE: manager-or-author) | notes/[id]/page.tsx:166,209,57 | |
| Archive | button | **only if `notes.archive`** + not archived; `window.confirm` → `/notes` | notes/[id]/page.tsx:236,58,118 | |
| back-to-list | button | → `/notes` | notes/[id]/page.tsx:160 | |

## Contractors

### `/contractors` — list — `contractors/contractors-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "צור" CTA | link | **only if `contractors.create`** → `/contractors/new` | contractors-list.client.tsx:31,22 | |
| Contractor row | link | → `/contractors/[id]` | contractors-list.client.tsx:58 | |
| ListPageShell pagination | buttons | | contractors-list.client.tsx:37 | |

### `/contractors/new` — `contractors/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| name/email/phone/specialty/companyId/notes | inputs | RHF+Zod | contractors/new/page.tsx:50-129 | |
| Cancel / "צור" | buttons | POST; `contractor_email_exists`→field, `forbidden` mapped → `/contractors/[id]` | contractors/new/page.tsx:134,137,36 | |

### `/contractors/[id]` — detail — `contractors/[id]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Archive | button | **only if `contractors.archive`** + not archived; `window.confirm` → `/contractors` | contractors/[id]/page.tsx:124,27,47 | |
| back-to-list | button | → `/contractors` | contractors/[id]/page.tsx:40,73 | |

## Members (Manager-only resource — BE 403s others)

### `/members` — list — `members/members-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Search input | input | client filter name/email/role | members-list.client.tsx:137 | |
| "הזמן" / Invite CTA | link | **only if `members.invite`** → `/members/new` | members-list.client.tsx:149,86 | |
| Member card | link | → `/members/[userId]` (shows active/pending/revoked) | members-list.client.tsx:172 | |
| pagination | buttons | | members-list.client.tsx:231 | |

### `/members/new` — invite — `members/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| email / name / role select | inputs | RHF+Zod; idempotent POST | members/new/page.tsx:146,162,176 | |
| Cancel / "הזמן" | buttons | POST member; `member_exists`→field error | members/new/page.tsx:193,196,68 | |
| (after) invite-token textarea | readonly | shown ONCE in non-prod only | members/new/page.tsx:109 | |
| Copy token | button | clipboard | members/new/page.tsx:118,78 | |
| back-to-list | button | → `/members` | members/new/page.tsx:129 | |

### `/members/[userId]` — detail — `members/[userId]/page.tsx` + capabilities/overrides panels

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Invite-recovery: Resend | button | **only if isPending + `members.invite`**; re-send email | members/[userId]/page.tsx:224,138 | |
| Invite-recovery: Copy link | button | when token returns (non-prod) | members/[userId]/page.tsx:234,160 | |
| Role select + "שמור" | form | **only if not revoked**; PATCH role; `cannot_modify_self`/`cannot_remove_last_manager` mapped | members/[userId]/page.tsx:255,278,113 | |
| Capabilities panel: preset picker + apply | select+button | agent only (manager/viewer → read-only preset text); applies named preset | member-capabilities-panel.tsx:183,197,132 | |
| Capabilities: view_owners / view_owner_pii toggles | checkboxes | pii⇒view_owners invariant enforced | member-capabilities-panel.tsx:216,224 | |
| Capabilities: 5 write-group toggles | checkboxes | edit_project_data/manage_documents/manage_signatures/manage_tasks/run_imports | member-capabilities-panel.tsx:244 | |
| Capabilities: reset preset / Save | buttons | reset to least-privilege floor / PATCH capabilities | member-capabilities-panel.tsx:154,262,107 | |
| Overrides panel | panel | **only if `roles.manage`** (Owner/Admin); per-user permission overrides | members/[userId]/page.tsx:289 | |
| Revoke | button | **disabled if revoked or primary**; `confirm` → `/members` | members/[userId]/page.tsx:297,123 | |
| back-to-list | button | → `/members` | members/[userId]/page.tsx:211 | |

## Imports

### `/imports` — list — `imports/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "העלאה" CTA | link | **only if `imports.run`** → `/imports/new` | imports/page.tsx:42,19 | |
| Import row | link | → `/imports/[id]` (status badge + dry-run chip) | imports/page.tsx:54 | |
| next/reset | buttons | pagination | imports/page.tsx:93,98 | |

### `/imports/new` — upload — `imports/new/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Project select | select | required | imports/new/page.tsx:114 | |
| File picker (.xlsx/.xls) | input(file) | mime + size (IMPORT_MAX_SIZE) checks | imports/new/page.tsx:137,37 | |
| Dry-run checkbox | checkbox | validate-only (no persist) vs preview-pause | imports/new/page.tsx:153 | |
| Upload progress bar | display | XHR progress | imports/new/page.tsx:158 | |
| Cancel / "העלאה" | buttons | presigned upload → `/imports/[id]`; many error codes mapped | imports/new/page.tsx:176,179,59 | |

### `/imports/[id]` — detail (SSE) — `imports/[id]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Cancel | button | when cancellable + not awaiting_confirm; `window.confirm` | imports/[id]/page.tsx:136,72 | |
| Preview-pause: "אשר טעינה" / confirm | button | when `awaiting_confirm`; POST confirm (real load) | imports/[id]/page.tsx:164,87 | |
| Preview-pause: cancel | button | discard | imports/[id]/page.tsx:167 | |
| "צפה בשגיאות" | link | → `/imports/[id]/errors` (when failedRows>0) | imports/[id]/page.tsx:171,246 | |
| Mapping wizard CTA | link | → `/imports/[id]/mapping` (when awaiting_mapping) | imports/[id]/page.tsx:231 | |
| Live SSE status | display | connecting/connected/lost | imports/[id]/page.tsx:125 | |
| back-to-list | link | → `/imports` | imports/[id]/page.tsx:100 | |

### `/imports/[id]/mapping` — wizard — `imports/[id]/mapping/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| 6 column-index inputs | inputs | 5 required + ownership_pct optional; dupe detection | mapping/page.tsx:147,165 | |
| Template name | input | optional save-for-reuse | mapping/page.tsx:190 | |
| Cancel / Submit | buttons | POST mapping → re-enqueue → `/imports/[id]`; `not_in_awaiting`/`dupe` mapped | mapping/page.tsx:211,214,104 | |
| (wrong-state guard) | display | bounce back if not awaiting_mapping | mapping/page.tsx:78 | |

### `/imports/[id]/errors` — `imports/[id]/errors/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Error table | display | read-only row/field/code/message | errors/page.tsx:45 | |
| Retry (on load fail) | button | refetch | errors/page.tsx:23 | |
| back link | link | → `/imports/[id]` | errors/page.tsx:35 | |

## Audit (Manager-only)

### `/audit` — `audit/audit-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Audit entry list | display | read-only; category/action/actor/target/when | audit-list.client.tsx:58 | |
| pagination/retry/access-denied | ListPageShell | 403 (`audit.read`) → access-denied | audit-list.client.tsx:40 | |

## Notifications

### `/notifications` — `notifications/notifications-list.client.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Filter chips (all/unread/signatures/tasks/documents/notes/mentions/apartments/shareRevoked) | buttons | client-side filter | notifications-list.client.tsx:160 | |
| "סמן הכל כנקרא" | button | only when unread>0; mark-all-read | notifications-list.client.tsx:139,88 | |
| Per-row "סמן כנקרא" | button | mark single read (unread rows only) | notifications-list.client.tsx:240,96 | |
| Per-row "פתח" / open | link | → `n.link` | notifications-list.client.tsx:222 | |
| next/reset | buttons | pagination | notifications-list.client.tsx:260,267 | |

## Messages (team chat — participation-gated)

### `/messages` — `messages/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "שיחה חדשה" + member picker | button + menu | toggle; pick ACCEPTED member → create 1:1 conversation | messages/page.tsx:146,166,94 | |
| Conversation list item | button | select thread; unread badge | messages/page.tsx:215 | |
| Composer textarea + Send | form | POST message; Enter sends (Shift+Enter newline); restore draft on fail | messages/page.tsx:334,344,358,80 | |
| (deep-link `?c=<id>`) | side-effect | opens that thread | messages/page.tsx:38 | |
| mark-read on open | side-effect | auto mark thread read | messages/page.tsx:73 | |

## Settings (org tier)

### `/settings` — tabs — `settings/page.tsx` + `_components/settings-tabs.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Tab bar (general/team/notifications/integrations/security) | buttons (tablist) | switch | settings-tabs.tsx:79 | |
| General: org/user identity | display | **read-only** (org rename is a future BE slice) | settings-tabs.tsx:106 | |
| General sub-configs (Branding/Localization/Limits/Consent) | forms | **read gated `org.settings.read`; save gated `org.settings.update`** | settings-tabs.tsx:148-151 · consent-config.tsx:30 | |
| Team tab: "פתח חברים" | link | → `/members` | settings-tabs.tsx:166 | |
| Team tab: roles link | link | **only if `roles.manage`** → `/settings/roles` | settings-tabs.tsx:171,55 | |
| Notifications tab | NotificationsConfig | read/update gated `org.settings.*` | settings-tabs.tsx:180 | |
| Integrations tab | display | **🔒 coming-soon stub** | settings-tabs.tsx:182 | |
| Security tab | display | **🔒 coming-soon stub** | settings-tabs.tsx:191 | |

### `/settings/roles` — `settings/roles/page.tsx` + `_components/roles-screen.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| WHOLE PAGE | gate | **only if `roles.manage`** (else "not authorized"); skeleton while `/me` resolves | roles/page.tsx:29 | |
| RolesScreen | management UI | role/permission management (Owner/Admin) | roles/page.tsx:41 | |

---

# Tier 2 — Contractor (share-based, JSONB perms)

### Landing `/contractor/share/[token]` — `(contractor)/contractor/share/[token]/route.ts`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| (route handler) | redirect | exchanges URL JWT → httpOnly cookie → 302 to token-less `/contractor/share` | contractor/share/[token]/route.ts | |

### `/contractor/share` — clean read-view — `(contractor)/contractor/share/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Project header + status | display | name/type/STATUS (no owner data ever) | contractor/share/page.tsx:95 | |
| Progress section | display | **only if `permissions.signatures`** — AGGREGATE counts only | contractor/share/page.tsx:113 | |
| Buildings/apartments | display | structural only (address + apt count) | contractor/share/page.tsx:140 | |
| Documents "הורד" / Download | button | **only if `permissions.documents`** + per-doc; opens presigned URL | contractor/share/page.tsx:181,65 | |
| invalid-link state | display | whole-page error on dead/revoked cookie (no oracle) | contractor/share/page.tsx:77 | |

---

# Tier 2 — Tenant (resident portal, SMS OTP)

### `/tenant/login` — `(auth)/tenant/login/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Step 1: phone input (+ optional org-slug) | inputs | client phone validation; `?org=<slug>` pre-fills slug | tenant/login/page.tsx:359,380,143 | |
| "שלח קוד" / Send code | submit | POST `/auth/otp/request`; always generic 200 (anti-enum) → step 2 | tenant/login/page.tsx:410,233 | |
| Step 2: 6-digit code input | input | auto-submit on 6 digits (one-shot per value) | tenant/login/page.tsx:435,196 | |
| "אמת" / Verify | submit | POST `/auth/otp/verify`; sets cookie → `/portal` | tenant/login/page.tsx:466,289 | |
| "שלח שוב" / Resend | button | 30s cooldown; re-request OTP | tenant/login/page.tsx:475,270 | |
| "שנה מספר" / Change phone | button | reset to step 1 | tenant/login/page.tsx:488 | |
| "לא דייר?" | link | → `/login` | tenant/login/page.tsx:507 | |

### `/portal` — tenant portal — `(tenant)/portal/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Hero / apartment cards | display | read-only own apartment(s) | portal/page.tsx:251 | |
| My details (PII masked) | display | national_id/phone MASKED (D.47); phone read-only (OTP factor) | portal/page.tsx:343 | |
| Email row: "ערוך"/"הוסף" | button | inline edit toggle | portal/page.tsx:705 | |
| Email edit form: save/cancel | form | **only self-editable field**; PATCH `/portal` contact | portal/page.tsx:713,736,739,687 | |
| Project progress (aggregate) | display | read-only counts only (never other residents) | portal/page.tsx:393 | |
| Documents section | display | metadata only (download is out-of-band per the hint) | portal/page.tsx:456 | |
| Signatures: "שלח שוב" / Resend | button | per pending signature; resend SMS link | portal/page.tsx:568,109 | |
| Signatures hint | display | actual signing is via the SMS link (`/sign/[token]`) | portal/page.tsx:591 | |
| all-errored → bounce | side-effect | if all 4 queries error → `/tenant/login` | portal/page.tsx:148 | |
| Logout (sidebar/topbar) | button | tenant tier → local cookie clear → `/tenant/login` | logout-button.tsx:70 | |

---

# Public signer (anonymous, JWT-bearer)

### `/sign/[token]` — resident signing — `sign/[token]/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Document inline preview (iframe) | display | sandboxed PDF; `onError` → new-tab fallback | sign/[token]/page.tsx:302 | |
| "פתח מסמך" / open in new tab | link | re-verified https presigned URL | sign/[token]/page.tsx:318 | |
| Consent checkbox | checkbox | **only if org `requireExplicitConsent`**; gates Submit | sign/[token]/page.tsx:351 | |
| Signature canvas | canvas | draw signature → SVG | sign/[token]/page.tsx:372 | |
| "נקה" / Clear | button | clear canvas | sign/[token]/page.tsx:379 | |
| "חתום" / Submit | button | disabled until non-empty + consent; POST signature; single-use | sign/[token]/page.tsx:386,113 | |
| invalid state | display | generic "link no longer valid" (no oracle) + recovery → `/he/tenant/login` | sign/[token]/page.tsx:192,207 | |
| done state | display | confirmation + signedAt | sign/[token]/page.tsx:218 | |

---

# Tier 3 — Provider Admin (cross-tenant console, MFA)

### `/provider/login` — `(auth)/provider/login/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| email / password / mfa_code | inputs | MFA mandatory (TOTP or recovery code) | provider/login/page.tsx:123,141,165 | |
| "התחבר" / Login | submit | POST `/provider/auth/login`; sets provider cookie → `/provider`; anti-enum (no `error.code` branch) | provider/login/page.tsx:185,78 | |
| (no link to org login) | — | intentionally obscure (operator runbook) | provider/login/page.tsx:60 | |

### Access-reason gate (wraps ALL `/provider/*`) — `components/provider/access-reason-gate.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Reason input + submit | form | blocks the whole provider subtree until a reason (ticket-ref OR ≥20 chars) is entered (sessionStorage, per-tab) | access-reason-gate.tsx:96,112,63 | |

### PCSidebar (provider nav) — `(dashboard)/_components/pc-sidebar.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| דשבורד פלטפורמה (overview) | nav link | → `/provider` | pc-sidebar.tsx:101 | |
| ארגונים (orgs) | nav link | → `/provider/tenants` | pc-sidebar.tsx:102 | |
| משתמשים (users) | nav link | → `/provider/tenants?view=users` | pc-sidebar.tsx:106 | |
| תוכניות ומחירון (plans) | span | **🔒 stub** (aria-disabled, padlock) | pc-sidebar.tsx:108 | |
| חיובים ומנויים (billing) | span | **🔒 stub** | pc-sidebar.tsx:109 | |
| תמיכה ופניות (support) | span | **🔒 stub** | pc-sidebar.tsx:110 | |
| תפקידים והרשאות (roles) | span | **🔒 stub** | pc-sidebar.tsx:112 | |
| אינטגרציות (integrations) | span | **🔒 stub** | pc-sidebar.tsx:113 | |
| בריאות מערכת (health) | nav link | → `/provider/system-health` | pc-sidebar.tsx:114 | |
| גיבויים ושחזור (backups) | nav link | → `/provider/backups` (page is honest read-only posture, NOT a stub) | pc-sidebar.tsx:115 | |
| יומן פעילות (audit) | nav link | → `/provider/audit` | pc-sidebar.tsx:116 | |
| הפעילות שלי (selfAudit) | nav link | → `/provider/audit/self` | pc-sidebar.tsx:117 | |
| צוות EMAPP (staff) | span | **🔒 stub** | pc-sidebar.tsx:119 | |
| הגדרות פלטפורמה (settings) | span | **🔒 stub** | pc-sidebar.tsx:120 | |
| Logout | button | provider tier → `/provider/auth/logout` → `/login` | pc-sidebar.tsx:327 · logout-button.tsx:62 | |

### `/provider` — dashboard home — `provider/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| System-health gauge | display | overall severity chip | provider/page.tsx:41 | |
| "ארגונים" / tenants | link | → `/provider/tenants` | provider/page.tsx:68 | |
| "יומן" / audit | link | → `/provider/audit` | provider/page.tsx:72 | |
| "בריאות מערכת" | link | → `/provider/system-health` | provider/page.tsx:75 | |

### `/provider/tenants` — list — `provider/tenants/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "createTenant" CTA | link | → `/provider/onboard` | provider/tenants/page.tsx:48 | |
| Search input + "search" + "clear" | input+buttons | name search (Enter or button); NOT an HTML form (no GET surface) | provider/tenants/page.tsx:63,74,78 | |
| `?view=users` hint | display | usersMode → per-row links go to `…/users` | provider/tenants/page.tsx:53 | |
| Tenant row | link | → `/provider/tenants/[id]` (or `…/users` in usersMode); archived/suspended chips | provider/tenants/page.tsx:113 | |
| pagination/retry | ListPageShell | | provider/tenants/page.tsx:92 | |

### `/provider/tenants/[id]` — detail — `provider/tenants/[id]/page.tsx` + suspension panel

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Suspend | button | not-suspended; reveals note field → confirm-suspend (freeze, reversible) | tenant-suspension-panel.tsx:100,143,59 | |
| Reactivate | button | suspended only; `window.confirm` | tenant-suspension-panel.tsx:95,70 | |
| Suspend note + confirm/cancel | form | optional operator note (`method=post`) | tenant-suspension-panel.tsx:119,143,146 | |
| Counts grid + sample owners | display | masked PII only (nameMasked/phoneMasked; national_id never on wire) | tenant/[id]/page.tsx:100,113 | |
| "viewUsersForTenant" | link | → `/provider/tenants/[id]/users` | tenant/[id]/page.tsx:157 | |
| "viewAuditForTenant" | link | → `/provider/audit?orgId=[id]` | tenant/[id]/page.tsx:162 | |
| back-to-list | button | → `/provider/tenants` | tenant/[id]/page.tsx:91 | |

### `/provider/tenants/[id]/users` — masked members — `provider/tenants/[id]/users/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| Member list | display | **READ-ONLY**, masked name/email; role + status + last-login | tenant/[id]/users/page.tsx:72 | |
| back-to-tenant | button | → `/provider/tenants/[id]` | tenant/[id]/users/page.tsx:49 | |
| pagination/retry | ListPageShell | | tenant/[id]/users/page.tsx:54 | |

### `/provider/onboard` — create org — `provider/onboard/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| orgName / managerName / managerEmail | inputs | RHF+Zod; audit-first `withProvider` write | onboard/page.tsx:135,149,165 | |
| Cancel / Submit | buttons | POST onboard; success → invite-token-once screen | onboard/page.tsx:181,184,54 | |
| (after) invite-token textarea + Copy | readonly+button | shown once in non-prod | onboard/page.tsx:97,106,64 | |
| back-to-list | button | → `/provider/tenants` | onboard/page.tsx:117 | |

### `/provider/audit` — cross-tenant search — `provider/audit/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| orgId / action / fromDate / toDate filters | inputs | SA-4: at least orgId OR fromDate(span ≤31d); default past 7d | provider/audit/page.tsx:144,160,176,188 | |
| `?orgId=<uuid>` deep-link | side-effect | pre-fills orgId | provider/audit/page.tsx:65 | |
| Reset / Search | buttons | disabled when SA-4 violated; resets cursor | provider/audit/page.tsx:203,206,108 | |
| Audit row org link | link | → `/provider/tenants/[orgId]` | provider/audit/page.tsx:248 | |
| pagination/retry | ListPageShell | | provider/audit/page.tsx:213 | |

### `/provider/audit/self` — self-audit — `provider/audit/self/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| affectedOrgId / actionType / from / to filters | inputs | all optional (no SA-4); default past 30d | self/page.tsx:121,137,153,165 | |
| Reset / Search | buttons | resets cursor; only fromDate≤toDate constraint | self/page.tsx:180,183,86 | |
| Row org link(s) | links | → `/provider/tenants/[orgId]` | self/page.tsx:239 | |
| pagination/retry | ListPageShell | | self/page.tsx:190 | |

### `/provider/system-health` — `provider/system-health/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| "refresh" | button | immediate refetch of health gauges | system-health/page.tsx:223 | |
| Queue / Pool / R2 gauges | display | read-only severity metrics | system-health/page.tsx:249 | |

### `/provider/backups` — `provider/backups/page.tsx`

| Element | Type | Expected behavior | Source | Status |
|---|---|---|---|---|
| WHOLE PAGE | display | **read-only honest posture** (Neon PITR docs; NO live call, NO interactive controls). NOT a stub — it's a real informational page. | backups/page.tsx:54 | |

---

## Permission → role quick reference

`useHasPermission(p)` reads the `/me` effective set. The catalog permissions
that gate FE controls (and the roles that hold them by default):

| Permission | Manager | Agent | Viewer | Gates (control) |
|---|---|---|---|---|
| `projects.create` | ✓ | – | – | New-project CTAs (home, list, wizard) |
| `projects.archive` | ✓ | – | – | Project archive |
| `export.run` | ✓ | – | – | Project Excel export |
| `owners.read` | ✓ | iff view_owners | ✓ | Owners nav + page |
| `owners.create` | ✓ | cap | – | Owner create CTA |
| `owners.archive` | ✓ | cap | – | Owner archive |
| `/me.view_owner_pii`¹ | ✓ | iff cap | – | Reveal-PII + download-signed-cert |
| `buildings.create` | ✓ | cap | – | Building create + parcel-setup |
| `apartments.create/update/archive` | ✓ | cap | – | Apartment create/status/archive/tabu |
| `documents.create/download/archive` | ✓ | cap | view: download? | Upload / view+download / archive |
| `signature_requests.send` | ✓ | cap | – | Create / copy-link / campaign |
| `signature_requests.cancel` | ✓ | cap | – | Cancel signature request |
| `tasks.create/update` | ✓ | ✓ | – | Task create / edit form |
| `notes.create/update/archive` | ✓ | ✓ | – | Note create / edit / archive |
| `contractors.create/archive` | ✓ | – | – | Contractor create / archive |
| `members.read/invite` | ✓ | – | – | Members nav / invite + resend |
| `roles.manage` | Owner/Admin | – | – | Roles page + per-user overrides + roles link |
| `project_assignments.manage` | ✓ | – | – | Assign / unassign |
| `imports.run` | ✓ | cap | – | Import upload CTA |
| `audit.read` | ✓ | – | – | Audit nav + page |
| `org.settings.read/update` | ✓ | – | read? | Settings config read / save |

¹ `view_owner_pii` is the LEGACY capability signal on `/me`, not an engine
permission — it is the authority the FE uses for PII reveal + signed-cert
download (matches the BE fidelity gate). "cap" = the agent holds it iff the
matching `AgentCapabilities` flag is granted in the member capabilities panel.

> The BE `AuthorizationGuard` is authoritative on every endpoint. FE gating is
> UX-only (never render a dead control that 403s). When a Status shows ⚠️ for a
> role that lacks the capability, that is EXPECTED, not a bug.

---

## Intentional stubs / read-only surfaces — DO NOT re-confirm as "broken"

| Surface | Where | Why |
|---|---|---|
| Home WeekCalendar panel | manager-home.tsx:115 | Phase-2 deferred empty-state |
| Provider sidebar: plans, billing, support, roles, integrations, staff, settings | pc-sidebar.tsx:108-120 | `aria-disabled` spans with padlock — BE slices not built |
| Provider backups page | backups/page.tsx | honest read-only DR posture (no live data by design) |
| Provider system-health / audit / self-audit | system-health/page.tsx etc. | read-only views (health has a refresh button; rest are search/list) |
| Provider tenant users page | tenant/[id]/users/page.tsx | READ-ONLY masked members (no member actions this slice) |
| Settings: Integrations + Security tabs | settings-tabs.tsx:182,191 | coming-soon stubs |
| Settings: General identity block | settings-tabs.tsx:106 | read-only (org rename = future BE slice) |
| `/signup` page | signup/page.tsx:27 | redirects to `/login` unless `NEXT_PUBLIC_SIGNUP_ENABLED=1` |
| Owner quick-actions row | (removed) owner-detail.client.tsx:270 | ship-or-hide; intentionally absent |
| `/apartments` (bare) | apartments/page.tsx | redirects to `/projects` (no global apt list) |
| Project list/card "—" placeholders (גוש/חלקה, יח״ד, חתימות) | projects-list.client.tsx:254 | wire fields not enriched yet (`dataPendingHint`) |
| Project detail "contractor" KPI "—" | project-detail.client.tsx:184 | wire field not exposed |
| Members "activity" KPIs | (not ported) members-list.client.tsx | no per-member aggregator endpoint |
