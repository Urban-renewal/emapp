# EMAPP — Information Architecture (E2 redesign, **v2 deep pass**)

> **Status:** grounded research proposal (read-only; no code changed). This is
> the council's SECOND pass and supersedes `docs/design-research/03-information-architecture.md`.
> Companion to `docs/DESIGN-NORTH-STAR.md`, `docs/design-research/v2/00-MASTER-PLAN.md`
> (when written), `docs/BACKLOG.md` (E1 audit), `docs/AUDIT-CHECKLIST.md`.
> Author: IA specialist, 2026-06-18.
>
> **Scope:** the **org tier** (Manager / Agent / Viewer) only. The tenant portal
> (`/portal`), contractor share-view (`/contractor/share`), public signer
> (`/sign/[token]`), and the provider console (its own `PCSidebar`, 16 nav
> entries) are **separate IAs** with their own already-workflow-shaped nav, and
> are touched here only at the seams (§9).
>
> **What changed from the first pass:** the first pass was right in its
> conclusions but theorised the project page from a stale read. I re-read the
> live files. The project page has been **reskinned again since** (the v11 A.S5
> tab structure), so the exact line numbers and tab IDs in the old doc are wrong.
> This pass cites the **current** code (as of 2026-06-18) and adds the data-layer
> grounding (what the wire actually carries) the first pass asserted but did not
> verify.

---

## 0. TL;DR

The current org-tier IA is a **flat entity catalog**: the sidebar
(`apps/web/src/app/[locale]/(dashboard)/_components/sidebar.tsx:113-145`) builds
**11 always-on nav lines + up to 3 gated Admin lines = up to 14** sibling
top-level items, one per database table (`/projects`, `/owners`, `/imports`,
`/documents`, `/signature-requests`, `/notifications`, `/tasks`, `/contractors`,
`/notes`, `/messages`, + Home, + the gated `/members`, `/audit`, `/settings`).
A low-tech **יזם** has to *assemble the workflow in his head* from a dozen CRUD
lists.

The redesign re-centers the IA on the **one spine that is the product**:

```
project → buildings → apartments → owners → signatures (→ the consent threshold %)
```

Concrete moves:

1. **Primary nav 14 → 5** (Home · Projects · Owners · Imports · Tasks). Everything
   else moves *into the project* (signature-requests, project documents, notes),
   into a collapsed **Admin** group (members, audit, settings), or into a
   **topbar utility cluster** (notifications bell — already exists; messages;
   global search).
2. **Project page opens on the signature board, not an empty tab.** Today the
   project still defaults to an **empty `tenants` CTA** (`project-detail.client.tsx:79`),
   and the real control board lives on the **4th `dashboard` tab**
   (`:300-428`). The board components already exist and already render real
   wire data — they are just buried.
3. **Triage at scale:** home = ~5 "needs you now" + a one-line pulse; projects
   list = full sort/filter/saved-views (today it has only **client-side
   name filtering of the current 25-row page** — `projects-list.client.tsx:69-79`).
4. **Global search omnibox** — extend the **existing** `POST /api/v1/owners/search`
   (PII-in-body, throttled — `owners.controller.ts:72-79`) into a cross-spine
   resolver. The POST-body-for-PII pattern is **already established**, not new.
5. **Migration = re-composition, not re-routing.** All **55 `page.tsx` route
   surfaces** keep responding; deep links + role-gating survive because gating
   lives in `middleware.ts` + the BE `AuthorizationGuard` + `useHasPermission`,
   **not** in the nav grouping (§8).

---

## 1. The problem, grounded in the live code

### 1.1 The sidebar is a schema dump (verified)
`sidebar.tsx:113-135` literally constructs a flat `NavItem[]`, one entry per
table, all at the same visual weight:

```
Home · Projects · (Owners) · Imports · Documents · Signature-requests ·
Notifications · Tasks · Contractors · Notes · Messages
```

then conditionally `push`es `Members` / `Audit` / `Settings`
(`sidebar.tsx:137-145`, gated on `members.read` / `audit.read` /
`org.settings.read`). There is **no grouping, no hierarchy, no notion that
`/signature-requests`, `/documents`, `/notes` are almost always *facets of a
project***. The `labelKey` union type (`sidebar.tsx:32-47`) enumerates all 14 —
it is a faithful mirror of the schema, which is exactly the problem.

To "chase a signature" today, the user opens the global `/signature-requests`
list, filters it in his head by which project each row belongs to, and acts. The
North Star ("the app already did the thinking") wants the inverse.

### 1.2 The spine is still inverted at the project level (re-verified, NEW detail)
The first-pass doc cited stale line numbers. Here is the **current** truth from
`projects/[id]/project-detail.client.tsx`:

- **Default tab is `tenants`** — `const [tab, setTab] = useState<TabId>('tenants')`
  (`:79`). It renders a `TabEmptyCta` whose only content is a button linking to
  `…/buildings` (`:264-277`). **The project opens on a dead-end placeholder.**
- **`docs` tab** — another `TabEmptyCta` linking out to the **global** `/documents`
  and `/signature-requests` lists (`:279-289`). The user is bounced to a global
  list and must reconstruct project context.
- **`tasks` tab** — `TabEmptyCta` → global `/tasks` (`:291-298`).
- **`dashboard` tab (4th, last)** — **this is the actual product.** It already
  renders, on real wire data:
  - `<SignatureProgressBoard>` (`:308`) — "X מתוך Y דירות הסכימו · Z% · יעד W%"
    + a threshold-colored bar (`signature-progress-board.tsx`), fed by
    `GET /api/v1/projects/:id/signature-progress` (`projects.service.ts:355`).
  - `<SignatureProgressApartments>` (`:312`) — per-apartment drill-down.
  - `<SignatureCampaignAction>` (`:321`) — the fan-out send, gated
    `signature_requests.send`.
  - `<ProjectDocumentUpload>` (`:317`), `<ParcelSetupSection>` (`:330`),
    `<SignatureProgressBar>` with milestone ticks (`:339`), renewal details,
    buildings/assignments/shares CTAs, archive.

So the single most important screen in the product — *"where does this project
stand on signatures, and who's stuck?"* — **is the 4th tab, behind two empty
placeholder tabs.** This remains the E1 headline finding
(`BACKLOG.md` E1 audit). **The fix is almost free**: the board already works;
it just needs to become tab 1 / the page itself.

### 1.3 Entities that only make sense in-context are global
- **`/apartments` (bare) already concedes the point** — it
  `redirect('/projects')` because a global apartment list is meaningless
  (`apartments/page.tsx`, "§FUNC-3 … no global list view"). Buildings/apartments
  are *correctly* nested (`/projects/[id]/buildings`, `/buildings/[id]`,
  `/apartments/[id]`). But `/signature-requests`, `/documents`, `/notes` have the
  **same "only-real-in-a-project" character for the daily flow** and are **not**
  nested.
- **`/owners` is dual-natured** (`owners/owners-list.client.tsx`): an owner is
  interesting both **as a person across her apartments/projects** (the global
  dense table — name · masked national_id · apartments count · pending) **and as
  a signatory inside one project**. The global list serves the first; nothing
  serves the second from the global nav. (The in-project view of "this owner's
  signature status" only exists implicitly inside the board's per-apartment
  drill-down.)

### 1.4 The home is a status photo, not a movie (re-verified, with a caveat)
`manager-home.tsx` renders **4 KPI cards** from `GET /api/v1/org/stats`
(`:54-105`: activeProjects / residents / signaturesReceived / pending), a
**WeekCalendar empty-state stub** (`:114-139`, "Phase-2 deferred"), and a
**recent-conversations panel** (`<HomeConversations>`, `:155`).

> **NEW since the first-pass doc (2026-06-18 edit):** the conversations panel is
> now **live** (team-messaging slice), not a "test-chat" stub as the old doc
> claimed. So the home is **KPI cards + calendar stub + live recent threads**.
> Still: it answers *"what are the totals?"*, not *"which 5 projects need me
> today and why?"* — the North Star's principle 3 + 4. The conversations panel
> is orthogonal to the signature mission and competes for the prime right-rail
> slot the pulse should occupy.

**Counter-model that already exists in-app:** `agent-home.tsx` is the right
shape — "My projects / My tasks / My notifications", each capped at
`HOME_LIMIT = 5` (`agent-home.tsx:43`), each a list of plain rows linking to the
detail, each degrading independently on a 403. **ManagerHome should converge on
the AgentHome pattern**, scaled to the org and re-centered on the signature
signal. The team can demonstrably build exception-first — they already did, for
the agent.

---

## 2. The mental model / the spine

One sentence the user already believes:

> *"I run **projects**. Each project is **buildings**; each building has
> **apartments**; each apartment has **owners**; my job is to get those owners to
> **sign** until the project crosses its **consent threshold**."*

That sentence **is** the IA. The route tree already encodes most of it — the nav
just doesn't reflect it:

```
Org
└─ Project ............... unit of work (status D.18, targetConsentPct, momentum)
   ├─ Buildings .......... /projects/[id]/buildings → /buildings/[id]
   │  └─ Apartments ...... /buildings/[id]/apartments → /apartments/[id]
   │     └─ Ownerships ... /apartments/[id]/ownerships (owner ⇄ apt, % share)
   ├─ Signatures ......... THE workflow surface (board + campaign + drill-down)
   ├─ Documents .......... what gets signed (today: global /documents + /signature-requests)
   ├─ Access ............. assignments (/…/assignments) + contractor shares (/…/shares)
   ├─ Activity ........... tasks + notes, scoped to this project
   └─ Setup .............. parcel auto-setup, Excel export, archive
```

### 2.1 Two axes, not one flat list
The entities split into **two relationship axes**; the IA should make the split
explicit instead of flattening both:

| Axis | Question it answers | Primary home |
|---|---|---|
| **Project axis** (vertical) | "Where does *this project* stand?" | inside `/projects/[id]` (board first) |
| **Person axis** (horizontal) | "Everything about *this owner*, across her projects" | `/owners/[id]` dossier |

An **owner spans many apartments and projects**; an **apartment has many
owners**; a **signature is the cell** at (owner × document × project). The
current IA models the project axis as URL nesting and leaves the person axis as a
flat global list with **no signature context flowing back**. Critically:
`owner-detail.client.tsx:59` already calls `useOwnerProjects(id)` and renders
rows linking to `/projects/${p.id}` (`:254`) — but those rows carry **no
signature status**. That is the concrete missing edge of the graph (§5.3, §6).

---

## 3. The proposed navigation model

### 3.1 Primary nav (sidebar): 14 → 5

Keep only **top-of-funnel entry points** + genuinely cross-project tools:

| Item | Route | Why it stays primary | Gating (carried over verbatim) |
|---|---|---|---|
| **ראשי / Home** | `/` | Triage mission-control (§5). | none |
| **פרויקטים / Projects** | `/projects` | The spine root; the list of units-of-work. | none |
| **בעלי דירות / Owners** | `/owners` | Person axis, cross-project. | `useHasPermission('owners.read')` — already gated at `sidebar.tsx:104,119-121` (an agent without `view_owners` never sees it) |
| **ייבוא / Imports** | `/imports` | Bulk data entry; org-wide; genuinely standalone. | none |
| **משימות / Tasks** | `/tasks` | A personal worklist that legitimately cross-cuts projects ("my tasks"). | none |

Everything else **leaves** the primary spine:

- **`/documents`, `/signature-requests`** → **tabs inside the project** (§3.2).
  The global library survives as a secondary destination, not a top-level line.
- **`/notes`** → folds into a per-project **Activity** tab + the owner dossier.
  There is no daily reason for a global notes list in the spine.
- **`/contractors`** → an **address book** reachable from the project **Access**
  tab (you grant a contractor a *share into a specific project* at
  `…/[id]/shares`; the global directory is not a daily destination).
- **`/messages`** → **topbar utility cluster** (team chat, orthogonal to the
  signature workflow; the home already surfaces recent threads).
- **`/notifications`** → already has a **topbar bell** (`topbar.tsx:51` →
  `<NotificationsBell>`). Drop the redundant primary nav line; keep the bell +
  the full `/notifications` page via "הצג הכל".
- **`/members`, `/audit`, `/settings`** → a collapsed **"ניהול / Admin"** group
  at the bottom of the sidebar. All three are **already** permission-gated
  (`sidebar.tsx:137-145`); grouping changes nothing about the gates — only
  Managers (and any role holding the reads) see the group.

**Result:** 5 spine items + a collapsed Admin group + a topbar utility cluster
(search · notifications bell · messages), instead of 14 equal-weight lines. This
is North Star principle 1 (progressive disclosure) applied to navigation itself.

> **Owner decision (D-IA-1):** is **Tasks** a primary spine item or a topbar
> utility? It cross-cuts projects (legit), but a developer-first reading might
> demote it to "my work" under the user menu and keep the spine to 4
> (Home · Projects · Owners · Imports). I recommend keeping Tasks at 5 for now
> (it is a daily destination for agents); flag for the owner.

### 3.2 The project page becomes the workflow hub (board-first)

Re-charter the tabs in `project-detail.client.tsx`. The project must **open on
the signature board** — the components already exist (`SignatureProgressBoard`,
`SignatureProgressApartments`, `SignatureCampaignAction`), so this is mostly a
**re-order + un-bury**, not new construction:

| New order | Tab | Content (mostly already built) | Source today |
|---|---|---|---|
| **1 (default)** | **חתימות / Signatures** | The board: "X מתוך Y · Z% · יעד W%" + threshold bar + per-apartment drill-down + **"who's stuck"** (the holdouts) + the campaign send. | `:300-346` (the current `dashboard` tab body) |
| 2 | **מבנה / Structure** | buildings → apartments → ownerships, inline (not a dead-end CTA). Per-apartment signature rollup shown here. | `…/buildings` (`:264-277`) made inline |
| 3 | **מסמכים / Documents** | project-scoped documents + the signature-requests **for this project** (today split across two GLOBAL lists). | merge `/documents` + `/signature-requests` filtered by project |
| 4 | **פעילות / Activity** | project-scoped tasks + notes. | `/tasks` + `/notes` filtered by project |
| 5 | **גישה / Access** | assignments (`…/assignments`) + contractor shares (`…/shares`). | `:382-408` |
| — | **הגדרות / Setup** (overflow) | parcel auto-setup (`:330`), Excel export (`:157-163`), archive (`:410-421`). | already present on the dashboard tab |

The deep routes `…/buildings`, `…/buildings/new`, `…/assignments`, `…/shares`,
`/buildings/[id]`, `/apartments/[id]`, `/apartments/[id]/ownerships` **keep their
URLs** — they become drill-down destinations *from these tabs* instead of being
reached by reconstructing context from a global list.

> **Honesty flag:** the project header KPI grid (`:178-217`) shows `—` for
> "contractor" and renders signatures as `signed/(signed+pending)` only when the
> wire carries those counts (`ProjectViewModel.signaturesSignedCount/PendingCount`,
> `project.vm.ts:82-84`). The **גוש/חלקה** column in the projects list is `—`
> (`projects-list.client.tsx:262`) **even though `block`/`parcel` ARE on the VM**
> (`project.vm.ts:64-66`) — a real "data exists, not surfaced" gap, not a
> missing-data gap. Surface גוש/חלקה from the VM; do **not** fabricate the others.

### 3.3 Global search omnibox (extend, don't invent)

A non-technical user with many projects should not have to know *which list* a
thing lives in. Add **one topbar omnibox** that resolves across the spine:
project name / address / גוש-חלקה / owner name / national_id / apartment.
Results are **typed** and route directly to the right detail (project board,
owner dossier, apartment).

**The PII pattern already exists and must be reused, not reinvented:**
`POST /api/v1/owners/search` takes the lookup term **in the body** (national_id /
phone are hash-compared server-side) and is **per-route throttled**
(`owners.controller.ts:64-79`, "Owner LOOKUP is POST /owners/search with the PII
in the BODY (never the URL)"). The omnibox's owner/national_id branch should call
this exact endpoint (or a thin cross-entity wrapper over it); the
project/apartment branches can be GET (no PII). The search **box** is global;
the **results respect the same per-role gating the lists already enforce** —
`view_owner_pii` gates the national_id branch and the masked preview, mirroring
`owners-list.client.tsx`'s masked columns.

> Per `apps/web/CLAUDE.md` security checklist: "No PII in URL query params —
> search via POST body (Doc 07 §7.10)". The omnibox MUST honor this. This is the
> single most leveraged add for the many-projects problem.

---

## 4. Scale: navigating MANY projects

North Star principle 3 — many projects; home shows the ~5 that need you now, full
power one tap away. Three levels:

1. **Home = triage (default).** Not all-N. §5.
2. **Projects list = full power (one tap).** Today `/projects`
   (`projects-list.client.tsx`) has: a cards/table toggle (`:59`), **client-side
   name/type/status filtering of the visible 25-row page only** (`:64,69-79`),
   and cursor pagination (`:64,341-352`). The author comment is explicit:
   *"Search is CLIENT-SIDE filtering over the current page … A real `?q=`
   server-side search needs a BE slice"* (`:35-41`). Upgrade to the
   North-Star-promised surface:
   - **Sort by threshold-distance — buildable TODAY, zero BE.** *Closest to
     crossing* and *biggest gap to target* are pure functions of
     `signaturesSignedCount` / `signaturesPendingCount` / `targetSignaturePct`,
     which are **already on the wire** (`ProjectListItem`,
     `packages/shared-types/src/project.ts:218-225`; surfaced by
     `adapters/project.ts:104-112`). Ship this sort in S3 with no BE slice.
   - **Sort by momentum / "most stalled"** — needs *days since last signature*,
     which is **NOT on the wire** (no `lastSignatureAt` field anywhere; §7).
     This one needs BE enrichment; **until it lands, omit, do not fake** (the
     list already honors this with `dataPendingHint`, `:199-201`).
   - **Filter** by status (D.18 enum: `planning | gathering_signatures | approved
     | in_construction | completed | cancelled`), by assigned agent, by "needs
     attention".
   - **Saved views** — pin a named filter ("active gathering-signatures, sorted
     closest-to-threshold"). How a manager with 50 projects makes the list his.
3. **Search = direct jump** (§3.3) — bypass the list entirely.

**"Needs attention" predicate** is the connective tissue between home and list:
a project needs attention when it is *stalled* (no signature in N days),
*close to threshold* (one/two signatures from crossing), or *expiring*
(requests about to lapse — the `expired` status add, migration 0063, is
referenced in the master plan). Define the predicate **once** and feed both the
home triage list and the list's "needs attention" filter. The *blocked / "3
בעלים מתנגדים"* dimension needs the BE objection field that does **not exist
yet** — omit that phrase until it ships (§7, §8).

---

## 5. Home → list → detail hierarchy

### 5.1 Home (`/`) — signature mission-control
Replaces the KPI-cards + calendar-stub layout (`manager-home.tsx`), keeping the
conversations panel as a secondary right-rail item (it is now live).

- **"צריך אותך עכשיו / Needs you now"** — the ~5 projects matching the
  needs-attention predicate (§4), each a **plain-Hebrew sentence**, not a metric:
  *"כמעט שם · חסרה חתימה אחת"*, *"אין תנועה 18 יום"* (North Star 2 + 4). Each row
  → the project board (`/projects/[id]`).
- **"דופק / Pulse"** — one momentum line ("זז יפה, +2 השבוע" org-wide), not a
  card wall.
- **"כל הפרויקטים →"** — one tap to the full list (§4).
- Keep the **conversations** panel (live) in the right rail; demote the calendar
  stub (it is a deferred Phase-2 surface — ship-or-hide).

### 5.2 List level
- **Projects list** (`/projects`) — §4: server search + filter + sort + saved
  views.
- **Owners list** (`/owners`) — stays the person-axis directory (masked
  national_id, active/archived tabs — `owners-list.client.tsx:25-90`). A
  *find-a-person* tool; fine as a flat searchable list.
  - **Re-skin leak to fix here (cite for the visual-system pass):**
    `owners-list.client.tsx:153` uses Tailwind-default `bg-amber-100
    text-amber-800` for the pending pill instead of the EMAPP semantic tokens —
    a brand re-skin would silently miss it. Out of IA scope but IA-adjacent;
    surfaced for `05-visual-system`.
- **Tasks / Imports** — keep their existing list shells.

### 5.3 Detail level + the entity graph
The detail pages are the **cells of the (project × person) graph** and must
cross-link both axes:

| Detail | Today | Add for the graph |
|---|---|---|
| **Project** `/projects/[id]` | board on 4th tab (`:300`) | **board first**; each owner row → her in-project status + a link to her dossier |
| **Owner** `/owners/[id]` | dossier; `useOwnerProjects` rows → `/projects/[id]` (`owner-detail.client.tsx:59,254`) **without signature status** | extend each row to (apartment · project · **signature status**) so the dossier answers "where does this person stand everywhere" |
| **Apartment** `/apartments/[id]` | detail + ownerships + tabu | show its owners' signature status inline (the apartment × owners join) |
| **Signature request** `/signature-requests/[id]` | standalone detail | always show its (owner, document, project) context + a link back to the project board — never an orphan |

This is the answer to *"an owner spans apartments/projects; an apartment has many
owners; a signature belongs to owner+document+project"*: model it as a **graph
the user walks**, entered from either axis, with the signature as the shared
cell. The owner-dossier signature-status edge is the **highest-value missing
link** and is a small adapter/wire change, not a new screen.

---

## 6. Current-IA → Proposed-IA mapping (every route accounted for)

| Current (route) | Disposition | Proposed home | Notes |
|---|---|---|---|
| `/` (KPIs + calendar stub + live conversations) | **Re-charter** | `/` mission-control | calendar stub → hide; conversations → right rail |
| `/projects` | **Promote** (stays primary) | `/projects` upgraded | + server search/filter/sort/saved-views (§4) |
| `/projects/[id]` (4 tabs, board last) | **Re-order** | board-first | URL unchanged; §3.2 |
| `…/buildings`, `…/buildings/new`, `/buildings/[id]`, `…/apartments`, `/apartments/[id]`, `…/ownerships` | **Keep** (already nested) | drill-down from **Structure** tab | URLs unchanged |
| `…/assignments`, `…/shares` | **Keep**, regroup | project **Access** tab | URLs unchanged |
| `/owners`, `/owners/[id]`, `/owners/new` | **Keep**, demote to person-axis directory | `/owners` (still primary) | cross-link dossier rows with signature status (§5.3) |
| `/apartments` (bare) | **Keep** (`redirect('/projects')`) | — | confirms "no global apt list" is correct |
| `/signature-requests`, `…/new`, `…/[id]` | **Demote** primary → in-project | project **Documents/Signatures** tabs | global list survives secondary; URLs unchanged |
| `/documents`, `…/new`, `…/[id]` | **Split**: project docs → in-project; library stays global-secondary | project **Documents** tab + a library link | nav line removed; URLs unchanged |
| `/tasks`, `…/new`, `…/[id]` | **Keep primary** + **mirror** in project | `/tasks` + project **Activity** | dual-surface (one component, two filters) |
| `/notes`, `…/new`, `…/[id]` | **Demote** primary → project Activity + owner dossier | project **Activity** tab | nav line removed; URLs unchanged |
| `/contractors`, `…/new`, `…/[id]` | **Demote** to address book | from project **Access** | nav line removed; URLs unchanged |
| `/messages` | **Demote** to topbar utility | topbar / home right rail | not part of the signature spine |
| `/notifications` | **Demote** (bell exists at `topbar.tsx:51`) | bell + page via "הצג הכל" | remove redundant nav line |
| `/members`, `…/new`, `…/[userId]` | **Regroup** into Admin | sidebar "ניהול" (gated `members.read`) | URLs unchanged |
| `/audit` | **Regroup** into Admin | sidebar "ניהול" (gated `audit.read`) | URLs unchanged |
| `/settings`, `/settings/roles` | **Regroup** into Admin | sidebar "ניהול" (gated `org.settings.read`) | URLs unchanged |
| `/imports`, `…/new`, `…/[id]`, `…/mapping`, `…/errors` | **Keep primary** | `/imports` | genuinely standalone bulk tool |
| **(new)** global search omnibox | **Add** | topbar | extend `POST /owners/search` (§3.3) |
| **(new)** "needs attention" predicate | **Add** (shared) | home + projects-list filter | define once (§4) |

**Promoted:** Projects (spine root + full-power list), the signature board
(tab 4 → tab 1). **Demoted:** signature-requests, documents, notes, contractors,
messages, notifications. **Merged:** project documents + signature-requests → one
in-project surface; tasks + notes → project Activity; members + audit + settings
→ Admin group. **Added:** global search, saved views, the needs-attention
predicate.

---

## 7. Data feasibility — what each IA move actually needs (grounded)

The IA is honest only if it never promises a signal the wire can't deliver.
Verified against the live services:

| IA element | Data needed | Status today | Source |
|---|---|---|---|
| Project board (board-first tab) | aggregate consent counts + target | **EXISTS** | `signatureProgress()` `projects.service.ts:355-435` → `GET /projects/:id/signature-progress` |
| Per-apartment "who's stuck" | per-apt owner/signed counts + status | **EXISTS** | `signatureProgressApartments()` `:456+` |
| Project-list `signed/(signed+pending)` | per-project signed+pending counts | **EXISTS** | `statsSubqueries` in `list()` `:202,242-244` |
| Project-list גוש/חלקה | `block`/`parcel` | **EXISTS on VM, not rendered** (`projects-list.client.tsx:262` shows `—`) | `project.vm.ts:64-66` |
| Home "needs you now" (~5) | velocity / days-stalled / threshold-distance / expiring | **PARTIAL** — counts exist; *time-since-last-signature* + *expiring soon* need an aggregate endpoint | master plan B1 `GET /org/signature-pulse` (copy the `orgStats` + agent-scope CTE) |
| Sort by **threshold-distance** (closest-to-crossing / biggest-gap) | per-project signed+pending + target | **EXISTS — zero BE** | `signaturesSignedCount`/`signaturesPendingCount`/`targetSignaturePct` on the wire (`shared-types/src/project.ts:218-225`; `adapters/project.ts:104-112`) |
| Sort by **momentum / most-stalled** | *days since last signature* per project | **DOES NOT EXIST** — no `lastSignatureAt` on the wire; `orgStats` is org-wide running totals only (`projects.service.ts:537-581`) | needs B1 enrichment / a `lastSignatureAt` read |
| "3 בעלים מתנגדים" / objection "why" | a decline/objection field | **DOES NOT EXIST** — one migration (`ALTER signature_requests ADD COLUMN decline_reason`) | master plan B2; **omit the phrase until it ships** |
| Saved views | per-user filter store | **DOES NOT EXIST** — small BE slice; can ship as URL-state first, persistence later | §4 |

> **Domain correctness flag (carried into IA because it changes what the board
> SAYS):** `signatureProgress()` counts `apartments_consented` as apartments
> where **all active owners signed** (`projects.service.ts:371-399`) — it
> **ignores `ownerships.share_numerator/denominator`** (stored, unused). The
> legal תמ"א/פינוי-בינוי majority is multi-dimensional (heads vs ownership-share
> vs per-building), so the headline "Z%" the board displays **can be legally
> wrong**. This is a P0 domain decision, **not an IA decision** — but the IA
> puts that number front-and-center (board-first), so the IA *raises the stakes*
> on getting it right. **Owner must confirm the counting rule** (also in
> `BACKLOG.md` T4). Surfaced here so the board-first decision is made with eyes
> open.

---

## 8. Migration that doesn't break role-gating or deep links — the GUARANTEES

The redesign is **a navigation/composition change, not a routing rewrite.** Four
guarantees, each grounded:

**G1 — No route is deleted.** All **55 `page.tsx` surfaces** under
`(dashboard)/` keep responding. `/signature-requests`, `/documents`, `/notes`,
`/contractors`, `/notifications`, `/messages` still resolve — they just stop
being primary nav lines and start being reached *through* the project or the
topbar. Existing bookmarks, notification deep-links (`n.link` targets), and
email/SMS links all still land.

**G2 — Role-gating is untouched because it lives in three authoritative layers,
none of which is the nav grouping:**
- **Middleware** (`src/middleware.ts`) gates by **tier cookie** — `access_token`
  (org), `provider_access_token`, `tenant_access_token` (`:170-172`). The IA
  change never touches the tier boundaries, the `PUBLIC_ROUTE_REGEX`
  (`:27-56`), the `/sign/[token]` carve-out (`:125`,
  `PUBLIC_LOCALE_AGNOSTIC_REGEX`), or the provider/tenant tier gates
  (`:273-300`). It is an **org-tier-internal** change.
- **BE `AuthorizationGuard`** — authoritative per endpoint. FE gating is UX-only
  (the codebase says so repeatedly: `use-permissions.ts:21-24`,
  `sidebar.tsx:93`).
- **FE `useHasPermission`** — the single FE gate (`use-permissions.ts:55-58`),
  reading the `/me` permission set. The sidebar's existing gates
  (`owners.read` / `members.read` / `audit.read` / `org.settings.read`,
  `sidebar.tsx:94-104,137-145`) **carry over verbatim** to the new grouping:
  Owners stays gated; the Admin group simply wraps the same three gates;
  promoting a control into the board tab does **not** ungate it (the board's
  campaign send keeps `signature_requests.send`; export keeps `export.run`
  `project-detail.client.tsx:73,157`; parcel-setup keeps `buildings.create`
  `:76,330`).

**G3 — Tier isolation is preserved by construction.** The provider console has
its **own** `PCSidebar` (16 nav entries; the dashboard layout already branches
to it for the provider tier — `sidebar.tsx:146-149`). Tenant
(`/portal`), contractor (`/contractor/share`), and public-signer
(`/sign/[token]`) IAs are untouched. This proposal **only** edits the org
sidebar + the org project page, so it **cannot** regress the tier boundaries the
middleware enforces.

**G4 — Sequence: low-risk → higher (each independently shippable + browser-verifiable):**
- **S1 (no-BE):** re-order the project tabs (board → default). Pure FE, biggest
  perceived win, zero data change. Just flip `useState<TabId>('tenants')` →
  `'dashboard'` and re-order the `tabs` array, then inline the empty-CTA targets.
- **S2 (no-BE):** collapse the sidebar — group Admin, drop the redundant
  notifications line (bell already exists), demote notes/contractors/messages.
  Routes untouched.
- **S3 (small BE):** the B1 `GET /org/signature-pulse` aggregate → home
  mission-control + project-list enrichment (days-stalled, threshold-distance)
  so list rows stop showing `—`. Also surface גוש/חלקה (already on the VM, zero BE).
- **S4:** global search omnibox (extend `POST /owners/search`; GET for non-PII
  branches).
- **S5:** saved views (URL-state first; persistence later).
- **B2 (Gate-6 migration):** the objection "why" field → unhide "3 בעלים
  מתנגדים". Until then the phrase is **omitted, never faked**.

**Per-role acceptance (regression suite):** after S1/S2, re-run the 4-axis
browser smoke per role (`docs/DOD-BROWSER-SMOKE.md`) — verify the **Agent** still
sees the scoped sidebar (no members/audit/settings, because `agent` lacks those
reads — `agent-home.tsx` confirms the scoped shape), the **Viewer** still has no
create CTAs (`projects-list.client.tsx:63,191`), and the demoted routes are still
reachable by deep link for the roles that held them. The IA change must introduce
neither a **dead** control nor a **newly exposed** one.

---

## 9. Risks & open questions

- **R1 — BE enrichment gates the best parts.** Sort-by-momentum,
  threshold-distance, and the "why" line need data the wire doesn't expose yet
  (§7). Mitigation: ship S1/S2 (no BE) first; surface signals only as they land;
  **never fabricate** — the list already models this with `dataPendingHint`.
- **R2 — "demote ≠ delete" must be communicated.** Power users who bookmarked
  `/signature-requests` or `/notes` will find the nav line gone. Mitigation:
  global search resolves them; the routes still work; consider a one-time "moved
  here" hint inside the project Documents/Activity tabs.
- **R3 — Tasks dual-surface drift.** Tasks live both globally (`/tasks`) and
  in-project (Activity). Risk of two inconsistent task UIs. Mitigation: one task
  component, two filters (assignee=me vs project=this).
- **R4 — Search must not become a national_id oracle.** Mitigation: reuse the
  **existing** `POST /owners/search` (PII in body, throttled — `:64-79`);
  `view_owner_pii`-gate the national_id branch + masked previews. Do not add a
  `?q=` PII query param anywhere (`apps/web/CLAUDE.md`).
- **R5 — Board-first amplifies the consent-correctness bug.** Making the
  possibly-legally-wrong "Z%" the first thing the user sees raises the cost of
  the §7 domain bug. Mitigation: land the **owner's counting-rule decision**
  (T4) before/with the board-first slice, or render the % with an explicit
  "by apartments" qualifier until share-weighting lands. **Owner decision.**
- **R6 — Other tiers unaffected, by design** (G3). Provider `PCSidebar`, tenant
  `/portal`, contractor `/contractor/share`, public `/sign/[token]` are separate
  IAs. This proposal must not regress the middleware tier boundaries.

### Owner decisions surfaced
- **D-IA-1:** Tasks = 5th spine item, or demote to topbar "my work" (spine of 4)?
- **D-IA-2 (= BACKLOG T4, P0):** the consent counting rule (heads vs
  ownership-share vs per-building) — blocking for board correctness, amplified by
  board-first.
- **D-IA-3:** saved views — ship as a persisted per-user store, or URL-state
  only for MVP?

---

## 10. One-line summary

**Stop making the user assemble the workflow from 14 CRUD lists.** Re-center the
org IA on the spine (project → buildings → apartments → owners → signatures),
make the **already-built signature board** the project's first tab instead of its
fourth, collapse the schema-dump sidebar to 5 spine items + an Admin group, add a
global search that **extends the existing `POST /owners/search`** PII pattern +
needs-attention triage for scale — and migrate by **re-composition, not
re-routing**, so all 55 routes, every deep link, and all three gating layers
survive untouched.
