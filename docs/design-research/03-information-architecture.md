# EMAPP — Information Architecture (E2 product redesign)

> **Status:** proposal (read-only research). Companion to `docs/DESIGN-NORTH-STAR.md`,
> `docs/BACKLOG.md` (E1 audit), `docs/AUDIT-CHECKLIST.md` (route inventory).
> Scope: the **org tier** (Manager / Agent / Viewer). Tenant portal, contractor
> share-view, public signer, and the provider console are separate IAs and are
> touched here only at the seams. Author: IA pass, 2026-06-18.

---

## 0. TL;DR

The current IA is a **flat entity catalog**: 14 sibling top-level nav items
(`/projects`, `/owners`, `/imports`, `/documents`, `/signature-requests`,
`/notifications`, `/tasks`, `/contractors`, `/notes`, `/messages`, `/members`,
`/audit`, `/settings` + Home) — one per database table. The user (a low-tech
real-estate **יזם**) has to *assemble the workflow in his head* from a dozen
CRUD lists. The North Star wants the opposite: **the app already did the thinking.**

The redesign re-centers the IA on the **one spine that is the product**:

```
project → buildings → apartments → owners → signatures (→ the threshold %)
```

Everything that is *only meaningful inside a project* (buildings, apartments,
ownerships, signature-requests, project documents, project tasks/notes,
assignments, shares, parcel-setup) **moves into the project** and stops being a
global list. Everything that is genuinely **cross-project** (owners as people,
the org-wide document library, imports, members, audit, settings) **stays
global but is demoted out of the primary spine**. The home stops being a wall of
counts and becomes **triage-by-exception**: the ~5 projects that need you now.

Net: primary nav drops from **14 items to ~5** (Home · Projects · Owners ·
Imports · Tasks), with the rest moving in-project or behind a global search /
utility cluster. **No routes are deleted** — deep links keep working — but the
*default path to every workflow* changes.

---

## 1. The problem with the current IA (entity-centric)

### 1.1 The nav is a schema dump
`apps/web/src/app/[locale]/(dashboard)/_components/sidebar.tsx:113-145` builds the
nav as a flat list, one item per table. There is **no hierarchy** — `/owners`,
`/documents`, `/signature-requests`, `/tasks`, `/notes` all sit at the same
level as `/projects`, even though for this product they are almost always
*facets of a project*. The user must know that "to chase a signature" he goes to
a global `/signature-requests` list, filters it, and reconstructs which project
each row belongs to.

### 1.2 The spine is inverted at the project level
The project detail (`projects/[id]/project-detail.client.tsx:115-120`) has 4 tabs
in this order:

1. **Tenants** (default) — but it's an **empty CTA** that just links to
   `…/buildings` (`project-detail.client.tsx:262-275`).
2. Docs — another empty CTA linking to the global `/documents` + `/signature-requests`.
3. Tasks — empty CTA linking to global `/tasks`.
4. **Dashboard** — *this is the actual signature control board* (progress
   `X/Y agreed · Z% · target W%`, per-apartment drill-down, the campaign send,
   parcel-setup) — `project-detail.client.tsx:306-328`.

So the **single most important screen in the product — "where does this project
stand on signatures?" — is the 4th tab, and the project opens on an empty
placeholder.** This is the E1 audit's headline finding (`BACKLOG.md:59`,
`:90`, `:100-102`): *the plumbing works; the IA buries the workflow.*

### 1.3 Entities that only make sense in context are global
- `/owners` is a flat org-wide list (`owners/owners-list.client.tsx`). An owner
  is interesting **as a person across her apartments/projects**, and also **as a
  signatory inside one project**. The global list serves the first; it does
  nothing for the second (the dominant daily need).
- `/apartments` (bare) **already admits this** — it `redirect('/projects')`
  because a global apartment list is meaningless
  (`AUDIT-CHECKLIST.md:322-326`). Buildings/apartments are *correctly* nested
  under `/projects/[id]/buildings` and `/buildings/[id]/apartments` — but
  `/signature-requests`, `/documents`, `/tasks`, `/notes` are **not**, even
  though they have the same "only-real-in-a-project" character for the daily flow.
- `/documents` mixes two different things: org-wide template/library documents
  and the **project document being sent for signature**. The signature flow
  (`signature-requests/new/page.tsx:133-158`) already couples document → owner →
  project, but the IA exposes them as three disconnected lists.

### 1.4 The home is a status photo, not a movie
`manager-home.tsx`: 4 KPI cards (`/org/stats`), a calendar **stub**
(`:115`, intentionally empty), and a recent-conversations panel (`:155`). It
answers "what are the totals?" It does **not** answer "which 5 projects need me
today and why?" — which is the North Star's principle 3 (triage by exception)
and 4 (momentum + the human "why").

---

## 2. The mental model / spine

One sentence the user already believes:

> *"I run **projects**. Each project is **buildings**, each building has
> **apartments**, each apartment has **owners**, and my job is to get those
> owners to **sign** until the project crosses its **consent threshold**."*

That sentence **is** the IA. Everything maps onto it:

```
Org
└─ Project ............... the unit of work (status, threshold %, momentum)
   ├─ Buildings .......... structure
   │  └─ Apartments ...... structure + per-apt signature rollup
   │     └─ Ownerships ... owner ⇄ apartment (% share)  → the signatory set
   ├─ Signatures ......... THE workflow surface (requests, progress, campaign)
   ├─ Documents .......... what gets signed / project paperwork
   ├─ People ............. assignments (org users) + shares (contractors)
   ├─ Activity ........... tasks + notes + audit, scoped to this project
   └─ Setup .............. parcel auto-setup, export
```

### 2.1 Two axes, not one flat list

The entities split cleanly into **two relationship axes**, and the IA should
make the split explicit instead of flattening both into one nav:

| Axis | Question it answers | Primary home |
|---|---|---|
| **Project axis** (vertical) | "Where does *this project* stand?" | inside `/projects/[id]` |
| **Person axis** (horizontal) | "Everything about *this owner*, across her projects" | `/owners/[id]` dossier |

An **owner spans many apartments and projects**; an **apartment has many
owners**; a **signature is the cell** at the intersection of
(owner × document × project). The current IA only models the project axis as
nesting and leaves the person axis as a flat list with no cross-links back into
context. The redesign keeps **both** axes navigable and **cross-links the cells**:

- From a project's signature board → click an owner → see her in-project status,
  with a link out to her full cross-project dossier.
- From an owner dossier → see every (apartment, project, signature-status) row →
  click through into that project's board.

This is the home→list→detail hierarchy expressed as a **graph with two entry
axes**, not a tree.

---

## 3. The proposed navigation model

### 3.1 Primary nav (sidebar) — 14 → ~5

Keep only the **top-of-funnel entry points** and genuinely cross-project tools:

| Item | Route | Why it stays primary |
|---|---|---|
| **בית / Home** | `/` | Triage-by-exception mission control (§5). |
| **פרויקטים / Projects** | `/projects` | The spine's root; the list of units-of-work. |
| **בעלים / Owners** | `/owners` | The person axis — cross-project. Gated `owners.read` (unchanged, `sidebar.tsx:104`). |
| **ייבוא / Imports** | `/imports` | Bulk data entry; org-wide; genuinely standalone. |
| **משימות / Tasks** | `/tasks` | A personal worklist that **legitimately cross-cuts** projects ("my tasks today"). Keep as a global view; also surface project-scoped tasks inside the project. |

Everything else leaves the primary spine:

- **`/documents`, `/signature-requests`** → become **tabs inside the project**
  (§3.2). The global library view survives as a secondary destination reachable
  from Projects-area utility, not a top-level nav line.
- **`/notes`** → folds into a per-project **Activity** tab and the owner dossier;
  there is no daily reason for a global notes list in the primary nav.
- **`/contractors`** → a **directory under Projects-area utility** (you assign a
  contractor a *share into a specific project* at `…/[id]/shares`; the global
  list is an address book, not a daily destination).
- **`/messages`** → **utility cluster** (topbar / secondary), not the spine. It
  is team chat, orthogonal to the signature workflow.
- **`/members`, `/audit`, `/settings`** → **Admin cluster**, collapsed under one
  "ניהול / Admin" group at the bottom of the sidebar (all three already
  permission-gated — `sidebar.tsx:137-145`; only Managers/Owners see the group).
- **`/notifications`** → already has a topbar bell (`notifications-bell.tsx`);
  drop the redundant primary nav line, keep the bell + the full `/notifications`
  page reachable from "הצג הכל".

**Result:** a calm 5-item spine + a collapsed Admin group + topbar utilities
(search, notifications, messages), instead of 14 equal-weight lines. This is
North Star principle 1 (progressive disclosure) applied to navigation itself.

### 3.2 The project page becomes the workflow hub (E2.2)

Re-order and re-charter the tabs in `project-detail.client.tsx`. The project
must **open on the signature board**, not an empty placeholder:

| New order | Tab | Content (mostly already exists) |
|---|---|---|
| **1 (default)** | **חתימות / Signatures** | Today's tab-4 "dashboard": progress `X/Y · Z% · target W%`, per-apartment drill-down (`:306-310`), campaign send (`:319`), **+ "who's stuck"** (the holdouts). This is the movie. |
| 2 | **מבנה / Structure** | buildings → apartments → ownerships (today's "tenants" CTA → `…/buildings`, but inline, not a dead-end). Per-apartment signature rollup shown here. |
| 3 | **מסמכים / Documents** | project-scoped documents + the signature-requests for this project (today split across two global lists). |
| 4 | **פעילות / Activity** | project-scoped tasks + notes + a project audit slice. |
| 5 | **גישה / Access** | assignments (`…/assignments`) + contractor shares (`…/shares`) — who can see/do what on this project. |
| — | **הגדרות / Setup** (overflow) | parcel auto-setup (`:328`), Excel export (`:159`), archive (`:413`). |

The deep routes `…/buildings`, `…/buildings/new`, `…/assignments`, `…/shares`,
`/buildings/[id]`, `/apartments/[id]`, `/apartments/[id]/ownerships`
**all keep their URLs** — they become the drill-down destinations *from these
tabs* instead of being reached by reconstructing context from a global list.

### 3.3 Cross-cutting: global search (new)

A non-technical user with many projects should not have to know *which list* a
thing lives in. Add **one global search** in the topbar (omnibox) that resolves
across the spine: project name / address / גוש-חלקה / owner name / national-id
(masked, permission-gated) / apartment. Results are **typed and route directly
to the right detail** (project board, owner dossier, apartment). This replaces
"go to the right list, then filter" with "type the thing." It is the scale
escape hatch (§4) and the single most leveraged add for the "many projects"
problem.

> Note: per the project security rules, national-id search must be POST-body,
> never a query param (`apps/web/CLAUDE.md` security checklist), and gated on
> `view_owner_pii`. The search **box** is global; the **results** respect the
> same per-role gating the lists already enforce.

---

## 4. Scale: navigating MANY projects

North Star principle 3: an org has many projects; the home shows the ~5 that
need you now, full power one tap away. The IA supports scale at **three levels**:

1. **Home = triage (default).** Not all-N. See §5.
2. **Projects list = full power (one tap).** The list at `/projects`
   (`projects-list.client.tsx`) today has client-side name search + a
   card/table toggle. Upgrade it to the **"full searchable/filterable/sortable"**
   surface the North Star promises:
   - **Sort by urgency / momentum / threshold-distance** — the three signals
     that matter: *closest to crossing the line*, *most stalled* (days since last
     signature), *biggest gap to target*. These need a small BE enrichment
     (the project list rows currently show `—` placeholders for חתימות/threshold
     — `AUDIT-CHECKLIST.md:850`); until then, **omit, don't fake** (North Star
     "What this is NOT").
   - **Filter** by status (`planning | gathering_signatures | approved |
     in_construction | completed | cancelled` — D.18), by assigned agent, by
     "needs attention".
   - **Saved views** — let the user pin filters ("My active gathering-signatures
     projects, sorted by closest-to-threshold") as a named view. This is how a
     manager with 50 projects makes the list *his*.
3. **Search = direct jump.** §3.3 — bypass the list entirely.

**"Needs attention" surfacing** is the connective tissue between home and list:
a project needs attention when it is *stalled* (no signature in N days),
*close to threshold* (one or two signatures from crossing), *blocked* (known
holdouts / objections — pending the BE "why" field, North Star E2 backend
follow-up), or *expiring* (signature requests about to lapse — E2.3). The same
"needs-attention" predicate powers both the home triage list and the list's
"needs attention" filter — define it **once**.

---

## 5. Home → list → detail hierarchy

### 5.1 Home (`/`) — signature mission-control (E2.1)
Replaces the KPI-cards + calendar-stub + test-chat layout (`manager-home.tsx`).

- **"צריך אותך עכשיו / Needs you now"** — the ~5 projects matching the
  needs-attention predicate (§4), each as a **plain-Hebrew sentence**, not a
  metric: *"כמעט שם · חסרה חתימה אחת"*, *"אין תנועה 18 יום"*, *"3 בעלים מתנגדים"*
  (North Star principle 2 + 4). Each row → project board (`/projects/[id]`).
- **"דופק / Pulse"** — a short momentum line ("זז יפה, +2 השבוע" across the org),
  not a card wall.
- **"כל הפרויקטים →"** — one tap to the full list (§4).
- **AgentHome** (`agent-home.tsx`) already does the right shape for the Agent
  ("My projects / My tasks / My notifications") — it is the proof the team can
  build exception-first. ManagerHome should converge on that pattern, scaled to
  the org and the signature signal.

### 5.2 List level
- **Projects list** (`/projects`) — §4: search + filter + sort + saved views.
- **Owners list** (`/owners`) — stays as the person-axis directory (masked PII,
  active/archived tabs — `owners-list.client.tsx`). It is a *find-a-person*
  tool, not a daily workflow surface, so it is fine as a flat searchable list.
- **Tasks / Imports** — keep their existing list shells.

### 5.3 Detail level + the entity graph
The detail pages are the **cells of the (project × person) graph** and must
cross-link both axes:

| Detail | Today | Add for the graph |
|---|---|---|
| **Project** `/projects/[id]` | 4 tabs, board buried | board first; from board, each owner row links to her in-project status + her dossier. |
| **Owner** `/owners/[id]` | dossier with "projects-tied rows" → `/projects/[id]` (`owner-detail.client.tsx:251`) | extend each row to (apartment · project · **signature status**), so the dossier answers "where does *this person* stand everywhere" — the person axis fully. |
| **Apartment** `/apartments/[id]` | detail + ownerships + tabu | show its owners' signature status inline; it is the (apartment × owners) join. |
| **Signature request** `/signature-requests/[id]` | standalone detail | always shows its (owner, document, project) context + a link back to the project board — never an orphan row. |

This is the answer to "an owner spans apartments/projects; an apartment has many
owners; a signature belongs to owner+document+project": model it as a **graph
the user walks**, entered from either the project axis (board → owner) or the
person axis (dossier → project), with the signature as the shared cell.

---

## 6. Current-IA → Proposed-IA mapping

| Current (route) | Disposition | Proposed home | Notes |
|---|---|---|---|
| `/` (ManagerHome KPIs + calendar stub + chat) | **Re-charter** | `/` mission-control | E2.1. Calendar stub stays deferred; chat moves to utility. |
| `/projects` | **Promote** (stays primary) | `/projects` (upgraded) | + sort/filter/saved-views/search (§4). |
| `/projects/[id]` (4 tabs, board last) | **Re-order** | `/projects/[id]` (board first) | E2.2 (§3.2). URL unchanged. |
| `/projects/[id]/buildings`, `…/buildings/new`, `/buildings/[id]`, `…/apartments`, `…/apartments/new`, `/apartments/[id]`, `…/ownerships` | **Keep** (already nested) | drill-down from project **Structure** tab | URLs unchanged. |
| `/projects/[id]/assignments`, `…/shares` | **Keep**, regroup | project **Access** tab | URLs unchanged. |
| `/owners`, `/owners/[id]`, `/owners/new` | **Keep**, demote to person-axis directory | `/owners` (still primary nav) | Cross-link dossier rows with signature status. |
| `/apartments` (bare) | **Keep** (already `redirect('/projects')`) | — | Confirms "no global apt list" is correct (`AUDIT-CHECKLIST.md:322`). |
| `/signature-requests`, `…/new`, `…/[id]` | **Demote** from primary → in-project | project **Documents/Signatures** tabs | Global list survives as a secondary destination; URLs unchanged. |
| `/documents`, `…/new`, `…/[id]` | **Split**: project docs → in-project; library stays global-but-secondary | project **Documents** tab + a library destination | URLs unchanged; nav line removed. |
| `/tasks`, `…/new`, `…/[id]` | **Keep primary** (legit personal cross-project list) **+ mirror** in project Activity | `/tasks` + project **Activity** tab | Dual-surface: global "my tasks", scoped "this project's tasks". |
| `/notes`, `…/new`, `…/[id]` | **Demote** from primary → project Activity + owner dossier | project **Activity** tab | Nav line removed; URLs unchanged. |
| `/contractors`, `…/new`, `…/[id]` | **Demote** to Projects-area address book | reachable from project **Access** / a utility link | Nav line removed; URLs unchanged. |
| `/messages` | **Demote** to utility cluster | topbar / secondary | Not part of the signature spine. |
| `/notifications` | **Demote** (already has bell) | topbar bell + page via "הצג הכל" | Remove redundant nav line. |
| `/members`, `…/new`, `…/[userId]` | **Regroup** into Admin cluster | sidebar "ניהול" group (gated `members.read`) | URLs unchanged. |
| `/audit` | **Regroup** into Admin cluster | sidebar "ניהול" group (gated `audit.read`) | URLs unchanged. |
| `/settings`, `/settings/roles` | **Regroup** into Admin cluster | sidebar "ניהול" group (gated `org.settings.read`) | URLs unchanged. |
| `/imports`, `…/new`, `…/[id]`, `…/mapping`, `…/errors` | **Keep primary** | `/imports` | Genuinely standalone bulk tool. |
| **(new)** global search omnibox | **Add** | topbar | §3.3 — the scale escape hatch. |
| **(new)** "needs attention" predicate | **Add** (shared) | home + projects-list filter | §4 — define once. |

**Promoted:** Projects (to spine root + full-power list), the signature board
(tab 4 → tab 1 / home centerpiece). **Demoted:** signature-requests, documents,
notes, contractors, messages, notifications (out of primary nav). **Merged:**
project documents + signature-requests → one in-project Documents/Signatures
surface; tasks + notes → project Activity; members + audit + settings → Admin
group. **Added:** global search, saved views, the needs-attention predicate.

---

## 7. Migration that doesn't break role-gating or deep links

The redesign is **a navigation/composition change, not a routing rewrite** — this
is what makes it safe:

1. **No route deletions.** Every path in `AUDIT-CHECKLIST.md` keeps responding.
   `/signature-requests`, `/documents`, `/notes`, `/contractors`,
   `/notifications`, `/messages` still resolve — they just stop being primary nav
   lines and start being reached *through* the project or a utility cluster.
   Existing bookmarks, notification `n.link` targets
   (`notifications-list.client.tsx:222`), and email/SMS deep links all still land.

2. **Role-gating is untouched because it lives in two authoritative layers, not
   in the nav:**
   - **Middleware** (`src/middleware.ts`) gates by *tier cookie*
     (`access_token` / `provider_access_token` / `tenant_access_token`) — the
     IA change never touches the tier boundaries, the public-route regex, or the
     `/sign/[token]` carve-out.
   - **BE `AuthorizationGuard`** is authoritative per endpoint
     (`AUDIT-CHECKLIST.md:830`); FE gating is UX-only.
   - The sidebar's existing permission gates (`useHasPermission('owners.read' |
     'members.read' | 'audit.read' | 'org.settings.read')`,
     `sidebar.tsx:94-104,137-145`) **carry over unchanged** to the new grouping:
     Owners stays gated, and the Admin group simply wraps the same three gates.
     Tabs inside the project inherit the same per-capability gating the actions
     already use (e.g. campaign send → `signature_requests.send`, parcel-setup →
     `buildings.create`, export → `export.run`). Promoting a control into the
     board tab does **not** ungate it.

3. **Sequence (low-risk → higher):**
   - **S1 (no-BE):** re-order the project tabs (board → default) — pure FE,
     biggest perceived win, zero data change. (E2.2 down-payment.)
   - **S2 (no-BE):** collapse the sidebar — group Admin, drop redundant
     notifications line, demote notes/contractors/messages. Keep the routes.
   - **S3 (small BE):** the "needs-attention" predicate + project-list
     enrichment (threshold-distance, days-stalled) so the list rows stop showing
     `—` (`AUDIT-CHECKLIST.md:850`). Then S3b: home mission-control consumes it.
   - **S4:** global search omnibox (BE search endpoint; POST-body for PII).
   - **S5:** saved views.
   - **Backend "why" layer** (owner objection/status) — North Star E2 follow-up;
     until it lands, the "3 בעלים מתנגדים" line is **omitted, not faked**.

4. **Per-role acceptance (the existing E1 walk is the regression suite):** after
   S1/S2, re-run the 4-axis browser smoke per role (`docs/DOD-BROWSER-SMOKE.md`)
   — verify Agent still sees the scoped sidebar (no members/audit/settings),
   Viewer still has no create CTAs, and the demoted routes are still reachable by
   deep link for the roles that held them. The IA change must not introduce a
   *dead* control or a *newly exposed* one.

---

## 8. Risks & open questions

- **R1 — BE enrichment gates the best parts.** Sort-by-momentum,
  threshold-distance, and the "why" line all need data the wire doesn't expose
  yet (`AUDIT-CHECKLIST.md:850-851`). Mitigation: ship the IA/structure first
  (S1/S2 need no BE), surface signals only as they land, **never fabricate**
  (North Star). Sequence so the structure is right even when a signal is blank.
- **R2 — "demote ≠ delete" must be communicated.** Power users who bookmarked
  `/signature-requests` or `/notes` will find the nav line gone. Mitigation:
  global search resolves them; the routes still work; consider a one-time
  "moved here" hint inside the project Documents/Activity tabs.
- **R3 — Tasks dual-surface drift.** Tasks live both globally (`/tasks`, "my
  tasks") and in-project (Activity tab). Risk of two inconsistent task UIs.
  Mitigation: one task component, two filters (assignee=me vs project=this).
- **R4 — Search + PII.** The omnibox must not become a national-id oracle.
  Mitigation: POST-body search, `view_owner_pii`-gated results, masked
  previews — mirror the list's existing posture (`owners-list.client.tsx`
  masked columns; `apps/web/CLAUDE.md` "No PII in URL query params").
- **R5 — Saved views scope creep.** Per-user saved filters imply a small BE
  store. Mitigation: ship list sort/filter first (URL-state, no persistence);
  add named saved views as a later slice only if the many-projects pain warrants
  it.
- **R6 — Other tiers unaffected, by design.** Tenant portal (`/portal`),
  contractor share-view (`/contractor/share`), public signer (`/sign/[token]`),
  and the provider console (`PCSidebar`, its own 13-item nav) are **separate
  IAs** with their own (already workflow-shaped) navigation. This proposal is
  scoped to the org tier and must not regress the tier boundaries the middleware
  enforces.

---

## 9. One-line summary

**Stop making the user assemble the workflow from 14 CRUD lists.** Re-center the
IA on the spine (project → buildings → apartments → owners → signatures), put the
signature board first, collapse the schema-dump sidebar to ~5 spine items + an
Admin group, add global search + needs-attention triage for scale, and migrate
by **re-composition, not re-routing** — so role-gating and every deep link
survive untouched.
