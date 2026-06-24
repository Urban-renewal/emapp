# DESIGN — External-Share "Invite a Party" Collaboration Redesign

**Status:** Decision-ready design proposal (no code). Author: lead (council pass).
**Date:** 2026-06-25.
**Scope:** Redesign the external-share "invite a party" flow that a scale-audit
found HALF-BUILT. The grant + authorization spine is sound; what is missing is
**recipient identity, honest delivery, scope legibility, and an org-wide
situation-picture**. This is a LEGIBILITY + HONESTY redesign — it does NOT loosen
the security spine.

**Reuse-not-reimplement (CLAUDE.md §ONE-SOURCE-OF-TRUTH):** every phase below
routes through a NAMED canonical seam. No parallel mechanism is invented.

---

## 0. TL;DR for the owner

The "invite a party" flow looks finished but is a façade in four ways:

1. **You can't tell WHO has access.** The create flow never asks for the party's
   name/email/phone, and the schema has no column for it. A share row says
   "a יזם can see Project Alpha" — never _which_ יזם, or how to reach them.
2. **"נשלח" (sent) is a lie.** The resend button toasts success, but the backend
   only bumps a timestamp — **no email or SMS is ever sent.** There is no
   out-of-band way for the party to reach the share (the token-delivery tier is
   unbuilt). This is an OUTCOME-gate violation.
3. **Scope reads as a number, not a place.** The list shows "1 פרויקט" instead of
   the project's NAME — useless at any scale.
4. **There's no "who has access to what" page.** Share management is buried
   inside ONE project's documents drill-down, yet it actually shows org-wide
   data — mislabeled and unfindable.

**The plan splits cleanly into buildable-now and owner-gated:**

- **Phases 1–4 (BUILD NOW):** recipient identity, honest copy, scope names, and a
  real org-wide situation-picture page. These add NO real outbound — they make the
  system honest and legible, and they prepare the delivery rails.
- **Phase 5 (OWNER-GATED, P5):** flip on REAL email/SMS delivery to REAL external
  parties through the existing governed-outbound seam. This is in the
  genuine-owner-gated set (sending real outbound to real recipients) and is
  prepared one-click, not performed autonomously.

---

## 1. Current-state assessment (file:line evidence)

### X-1 (CRITICAL) — a share carries NO recipient identity

The `external_share` table has `party_type` (a TAXONOMY) but no WHO:

- `packages/db/src/schema/external-share.ts:34-76` — columns are `orgId`,
  `partyType`, `scopeType`, `scopeIds`, `permissions`, `allowSensitive`,
  `otpRequired`, `expiresAt`, `watermarkSubject`, `createdBy`, lifecycle. **No
  `recipient_name` / `recipient_email` / `recipient_phone`.**
- `packages/shared-types/src/external-share.ts:72-87` — `CreateExternalShareInput`
  asks only for `partyType` + scope + perms. **The create flow never asks WHO.**
- `apps/api/src/modules/external-shares/external-shares.service.ts:206-220` — the
  insert persists party_type but no identity.
- FE create sheet `apps/web/src/app/[locale]/(dashboard)/_components/share-sheet.tsx`
  (title `הזמנת גורם`, submit `שתף ושלח`) collects party + scope + perms only — no
  contact fields.
- Audit row records `{ partyType, scopeType }` only
  (`external-shares.service.ts:224-227`).

**Consequence:** the manager cannot answer "who has access?" — only "what _type_
of party has access?". A second יזם share is indistinguishable from the first.

### X-2 (CRITICAL) — `resend` toasts "sent" but sends NOTHING

- `apps/api/src/modules/external-shares/external-shares.service.ts:417-438` —
  `resend()` does `UPDATE external_share SET updated_at = now()` + an audit log.
  The header comment is explicit: _"the OTP-access + delivery channel is X-S4;
  here we only bump updated_at + log."_ **No email/SMS provider is ever called.**
- FE `share-activity-panel.tsx:137-145` `onResend()` →
  `toast.show({ message: t('resendDone', …) })` → he.json `resendDone`:
  `"הקישור נשלח שוב ל{party}."` ("the link was sent again to {party}").
- The same gap exists at CREATE: `share-sheet.tsx` toasts `createdSent`
  (`"השיתוף נוצר — {party} קיבל גישה."` — "{party} received access") — but no
  party token is minted and nothing is delivered.

**Consequence:** an OUTCOME-gate violation (CLAUDE.md §G-QA OUTCOME). The UI
asserts an effect that never happened. The party has **no out-of-band way to
reach the share** — there is no party-facing token tier (`emapp-party`) and no
delivery. The grant exists in the DB but is unreachable.

### X-3 (HIGH) — scope shown as a raw count, not the place NAME

- `share-activity-panel.tsx:159-162` renders
  `t('row.scope', { count: share.scopeCount, type: … })` → he.json `row.scope`:
  `"{count} {type}"` → "1 פרויקט". **A count, not "Project Alpha".**
- Note the CREATE sheet already does this RIGHT (`share-sheet.tsx:218` uses
  `scope.label` = the project name) — because the name is in scope at mount time.
  The LIST has only `scopeIds` from the API and never resolves them to names.

### X-4 (HIGH) — no org-wide "who has access to what" page

- The only list surface is `ShareActivityPanel`
  (`share-activity-panel.tsx`), mounted INSIDE a project's documents drill-down:
  `docs-list.client.tsx:1234 → ProjectShareControls → :1328 ShareActivityPanel`.
- It fetches org-wide data with **no project filter**
  (`share-activity-panel.tsx:38` `useExternalShareList({ limit: 50 })`) — so it is
  **mislabeled**: it lives under "Project Alpha → documents" but lists every
  org-wide share. The BE `list()` is correctly org-scoped
  (`external-shares.service.ts:546-586`, keyset-paginated) — the FE just has no
  dedicated home for it.

**Consequence:** the manager has no place to stand and see the whole external-
collaboration surface ("100 contractors" scale, per the north-star). The data
exists and is paginated; it has no situation-picture.

### What is ALREADY SOUND (do not touch — reuse)

- **The authorization spine.** `PARTY_PRESET_CEILINGS` + `assertWithinCeiling` +
  `assertNarrowsOnly` (fail-closed, narrows-only, ceiling re-validated at
  create/update) — `external-shares.service.ts:138-345`.
- **The ONE shared retrieval resolver** `decideExternalPartyAccess`
  (`external-party-authz.ts:112-163`): lifecycle → permission → scope → sensitive
  (structural exclusion before OTP) → servability, all fail-closed, PII-free deny
  codes. The `otpVerified` signal is already a parameter — **X-S4 just has to
  supply a real verified value.**
- **No-oracle / suspended-org-inert** posture on every op
  (`external-shares.service.ts:56-57, 204, 243, 354, 382, 426, 469, 560`).
- **Keyset pagination** already wired on the list (`:561-585`).

---

## 2. Target design

### 2.1 Data model additions (one additive migration)

Add recipient identity to `external_share`. This is the X-1 fix and the
prerequisite for X-2 delivery.

```
external_share  (ADD columns — all nullable for backfill safety)
  recipient_name        text          -- display label (business/contact name; NOT national_id)
  recipient_email_enc   bytea/text    -- pgcrypto-encrypted (PII) — nullable
  recipient_phone_enc   bytea/text    -- pgcrypto-encrypted (PII) — nullable
  delivery_channel      text          -- 'email' | 'sms' | 'manual_link' (CHECK-pinned)
  last_delivered_at     timestamptz   -- set ONLY by a real governed send (NULL until then)
```

**Design rules:**

- `recipient_email`/`recipient_phone` are **PII** → encrypt via the existing
  `encryptField`/`decryptField` (pgcrypto, `PII_ENCRYPTION_KEY`) exactly like
  `owners.national_id`/`phone` (packages/db CLAUDE.md). **Never logged, never in
  error messages, never in audit `afterState`.**
- `recipient_name` is a **contact/business label**, treated like
  `contractors.name` (org-internal business data, NOT personal PII) — see the
  precedent comment at `shares.service.ts:313-318`. It MAY appear in the
  list UI and in notifications.
- At least ONE contactable channel is required when `delivery_channel != 'manual_link'`
  (Zod refine): email present if channel=email, phone if channel=sms.
- `delivery_channel='manual_link'` is the **honest fallback** — the manager copies
  a link and delivers it themselves; no outbound is claimed.
- `last_delivered_at` is the **honesty anchor**: NULL = "not yet delivered" → the
  UI must say so; non-NULL = a real governed send settled `sent`.

**Contract changes (`packages/shared-types/src/external-share.ts`):**

- Extend `CreateExternalShareInput` with `recipientName` (required, max len),
  `recipientEmail?` / `recipientPhone?` (validated by channel), `deliveryChannel`.
- Extend `ExternalShareView` with `recipientName`, `deliveryChannel`,
  `lastDeliveredAt`, and a **masked** `recipientContactMasked` (e.g.
  `da***@example.com` / `05*-***-**89`) — the view NEVER returns raw decrypted PII
  to the list; it returns a mask, mirroring the masked-PII toast precedent
  (memory `project_autonomy_reissue_delivery_gap`: `da***@…`).
- Add a `deliveryStatus` derived enum to the view:
  `not_delivered | delivered | delivery_failed | manual_link` (computed from
  `last_delivered_at` + the latest ledger outcome) — this is what drives the
  honest copy in X-2.

**Security note:** identity columns are additive and nullable; existing rows
backfill to NULL → `deliveryStatus='not_delivered'` (honest by default). No
existing grant's authorization changes — identity is orthogonal to the ceiling.

### 2.2 The delivery flow (X-2) — reuse `governOutboundSend` + the party token tier

The canonical end-to-end precedent is the signature-request reissue path:
`signature-requests.service.ts:2045-2074` calls `governOutboundSend(...)` with a
`send` thunk that delegates to an existing gated domain method (`this.resend`),
and the M1 ledger guarantees exactly-once. We REUSE that seam verbatim — the
Governor adds governance + exactly-once AROUND the send; it never re-implements
the send (`outbound-governor.ts:22-29`).

**The send is composed of two existing seams:**

**(a) Mint the party token — clone the `ShareTokenService` pattern (X-S4).**
`apps/api/src/modules/contractor-portal/share-token.service.ts` is the exact
template: a JWT with a **distinct audience** (`emapp-share`), a **dedicated
secret** (`SHARE_TOKEN_SECRET`, dev-fallback to `JWT_SECRET`), a TTL, and
**revocation-by-row** (the guard re-checks `revoked_at` every request, so a long
TTL never widens the live blast radius). The party tier is a structural twin:

- New audience `emapp-party` (NOT `emapp-share` — token-confusion isolation; the
  seam `SHARE_TOKEN_AUD_EXCHANGE` at `share-token.service.ts:47` shows the project
  already reserves new audiences additively).
- Payload binds to the `external_share.id` + `orgId` (the RLS boundary). Scope +
  perms + revocation live on the row, re-read live by the existing
  `resolveDocumentAccess` → `decideExternalPartyAccess` (NOTHING re-derived).
- TTL ≤ the grant's `expires_at`; revocation immediate via `external_share.revoked_at`.
- The party-portal read endpoints verify `emapp-party` and route EVERY document
  read through the **existing** `resolveDocumentAccess` (`:459-544`) — so the
  party tier inherits the full fail-closed resolver, including the `otpVerified`
  step-up (the OTP delivery for the step-up is itself X-S4's SMS-OTP, also via
  `governOutboundSend`).

**(b) Deliver the token link — the `send` thunk through `governOutboundSend`.**
A new thin `deliverPartyShare(shareId)` method is the **gated domain method** the
thunk calls. It resolves the recipient address (decrypt the encrypted column at
send time, never persisted in the ledger), renders the invite (link to the
party portal carrying the minted token), and calls the existing
`IEmailProvider`/`ISMSProvider`. The Governor wraps it:

```
governOutboundSend({
  orgId,
  proposalId: <synthetic invite cause OR null-causal — see note>,
  channel: share.deliveryChannel,            // 'email' | 'sms'
  recipientRef: shareId,                      // NON-PII discriminator (the share id)
  cadenceStep: 0,                             // invite = step 0; a re-invite is a new step
  recipientConsented: <from opt-out registry, FAIL-CLOSED default>,  // see §2.2.1
  killSwitchEnabled: serverEnv.CAMPAIGN_SEND_ENABLED !== '0' && … ,
  breakerTripped: false,
  now: new Date(),
  send: async () => { /* deliverPartyShare → provider; classify delivered/failed */ },
})
```

On `result:'sent'` → set `last_delivered_at = now()`, audit `external_share.deliver`,
and emit a manager-facing notification (see §2.3). On `blocked`/`failed`/`ambiguous`
→ DO NOT set `last_delivered_at`; surface the honest state (§2.4). The M1 ledger
(`outbound_ledger`) makes a double-click / retry exactly-once on
`(orgId, recipientRef:cadenceStep)`.

> **`proposal_id` note (seam reuse without distortion):** the current
> `outbound_ledger.proposal_id` is `NOT NULL` and FK-bound to `proposals`
> (`outbound-ledger.ts:58-60`) because every existing caller is proposal-driven.
> An external-share invite is **manager-initiated, not proposal-driven.** The
> clean reuse is a SMALL additive migration that makes `proposal_id` nullable and
> adds a `cause` discriminator (`'proposal' | 'external_share_invite'`), keeping
> ONE ledger + ONE governor for all governed outbound (the SINGLE-SOURCE rule).
> This is preferable to a parallel ledger. Flagged here as the one schema touch
> the delivery phase needs on a shared table — call it out for review.

#### 2.2.1 Consent — the reason Phase 5 is owner-gated

`governOutboundSend` consumes `recipientConsented`; the `ConsentGate` denies
(→ `blocked`, no ledger claim, no send) when false. **Today every caller
hard-codes `recipientConsented: true`** (`signature-requests.service.ts:1173`,
`:2057`) because the `recipient_opt_outs` registry is **NOT built** (confirmed:
no `recipient_opt_outs` table exists in the schema). The document-chase executor
already models the correct FAIL-CLOSED posture for a not-yet-consented recipient:
`recipientConsented: false` until the registry lands
(`document-chase-executor.ts`).

External parties are NEW outbound recipients with **no consent record at all**.
Sending real email/SMS to them is precisely the "sending real outbound to real
recipients" item in the genuine-owner-gated set (CLAUDE.md §EXECUTION POSTURE #3).
**Therefore real delivery is Phase 5 (owner-gated):** it activates only when the
owner approves the opt-out/consent registry + the kill-switch flip. Until then the
build is honest (`deliveryChannel='manual_link'` + "not delivered" copy) and the
rails are in place.

### 2.3 Manager-facing confirmation — reuse the notifications seam

The precedent is `shares.revoke` emitting `share_revoked` via
`NotificationsProducerService.emitMany` + `resolveNotificationRecipients` +
`notificationLink` (`shares.service.ts:339-376`). REUSE it:

- On a real `sent`: emit `external_share_delivered` to the project team
  (resolved via `resolveNotificationRecipients(tx, orgId, { projectId, actorUserId })`),
  body carries the `recipient_name` (business label, never PII) + the masked
  contact, `link: notificationLink.externalShares()` (a new link helper alongside
  `projectShares` at `notification-links.ts:24`).
- This satisfies the G-QA OUTCOME + "notifications actually fire" rule: the action
  is verified end-to-end, the manager SEES that the party really received it.

### 2.4 Honest copy + the situation-picture (X-3, X-4) — reuse the board primitives

**X-3 scope NAMES — reuse the portal scope-name-join.** The canonical pattern is
`portal.service.ts:227-284`: the join chain
`apartments → buildings → projects` selecting `projects.name`,
`buildings.address` (+`buildings.city`), `apartments.number` (+`apartments.floor`).
The external-share `list()` resolves each `scopeId` to a display name via the SAME
join (scoped by `scope_type`), and returns a `scopeLabel` (e.g. "Project Alpha",
"רחוב הרצל 12, תל אביב", "דירה 4, קומה 2") + a `scopeCount` only when >1. The FE
list renders the NAME, not the bare count. (Column truth confirmed:
`projects.name`, `buildings.address`/`city`, `apartments.number`/`floor`.)

**X-4 org-wide situation-picture — a dedicated page, not a buried panel.** Promote
the org-wide view to a first-class route (e.g. `/[locale]/(dashboard)/sharing` or
a "גישות חיצוניות" / "שיתופים" top-level surface). It is built on the existing
**situation-picture primitives** (the same grouping / attention-first / at-a-glance
pattern the documents party-binder + projects fleet use), NOT a flat wall:

- **Grouped by party / project** (the manager's two mental axes), each row a party
  card: WHO (recipient_name + masked contact + party_type label), WHAT
  (scope NAME), delivery status badge, expiry countdown, last-access.
- **Attention-first ordering** — surface what needs the manager: `not_delivered`
  (never reached the party) and `delivery_failed` at the top, then
  `expiring_soon`, then healthy. A `manual_link` share that was never copied is
  an attention item too.
- **At-a-glance honesty** — the delivery status badge is the X-2 fix made visible:
  「נמסר ✓」 (delivered, with date) vs 「ממתין לשליחה」 (not delivered — copy the
  link) vs 「השליחה נכשלה」 (failed — retry / copy link). No share ever silently
  claims "sent".
- **Keyset pagination** — reuse the already-wired `list()` cursor
  (`external-shares.service.ts:561-585`) so the page scales to hundreds of shares
  (search/filter by party_type already supported via the `partyType` query param).
- **One-click, fully-legible actions** per the technophobe lens: "שלח שוב"
  (re-deliver — real send in Phase 5, copy-link before that), "האריך"
  (extend TTL), "בטל גישה" (revoke). Each spells out what it does and to whom.

**User-keeps-control voice (memory `feedback_user_keeps_control_not_system_voice`):**
copy is framed as the manager's instrument — "{party} ממתין/קיבל גישה",
"לפי ההגדרות שלך", never a system "I sent" hero voice.

---

## 3. Security-invariants-preserved checklist

The redesign is legibility + honesty; the spine is UNCHANGED. Explicitly verified
against each invariant:

| Invariant                              | Preserved how                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fail-closed ceiling re-validation**  | `assertWithinCeiling` unchanged; identity columns are orthogonal to the ceiling — no new field widens scope/perms. `delivery_channel` carries no authority.                                                                                                                                       |
| **Narrows-only on update**             | `assertNarrowsOnly` unchanged. Recipient identity is set at create; an identity edit is NOT a scope/perm widening. (If identity is editable, gate it manager-only and audit it — no authz effect.)                                                                                                |
| **No-oracle 404s**                     | All new reads/ops keep the generic-404 posture (missing/cross-org/suspended → 404). The new org-wide page reuses the org-scoped `list()` (RLS-isolated).                                                                                                                                          |
| **Suspended-org-inert**                | `isOrgSuspended` gate added to `deliverPartyShare` exactly like `resend` (`:426`) — a frozen org delivers nothing.                                                                                                                                                                                |
| **PII never logged / never in errors** | `recipient_email`/`recipient_phone` pgcrypto-encrypted; the VIEW returns a MASK; ledger stores only the NON-PII `recipientRef` (the share id) + a generic `failureCode`; audit `afterState` carries party_type + recipient_name (business label) only — never the raw contact, never national_id. |
| **Token-confusion isolation**          | New `emapp-party` audience + dedicated secret, distinct from `emapp-share`/`emapp-api`/`emapp-tenant`/`emapp-sign` — a party token authenticates ONLY the party tier; no other tier's token passes the party guard and vice-versa.                                                                |
| **Revocation immediate**               | Party token is bound to `external_share.id`; the party-read guard re-checks `revoked_at`/`expires_at` LIVE every request via `decideExternalPartyAccess` (never trusted from the token) — long TTL ≠ wide blast radius.                                                                           |
| **ONE retrieval resolver**             | The party tier routes every doc read through the existing `resolveDocumentAccess` → `decideExternalPartyAccess`. No second authz path. The `otpVerified` gate is already structural; X-S4 supplies the real verified value.                                                                       |
| **Exactly-once outbound (M1)**         | Delivery goes through `governOutboundSend`; the `outbound_ledger` UNIQUE on `(org_id, recipientRef:cadenceStep)` makes double-click/retry exactly-once; ambiguous failures park (never auto-resend).                                                                                              |
| **Consent fail-closed**                | Real delivery denied (`blocked`) until the opt-out/consent registry + owner kill-switch — Phase 5. No real outbound ships ungated.                                                                                                                                                                |

**Red-team focus areas to hand the independent G-RT (Phase-by-phase):**

- Phase 1: can the masked-contact view be coaxed to leak raw email/phone? (mask in
  SQL/serializer, never decrypt into the list payload). National_id must never
  enter these columns (they are contact, not identity).
- Phase 2: token-confusion (an `emapp-party` token against `emapp-share`/org
  endpoints and vice-versa); revoked/expired share still serving via a live token;
  cross-org share id in the token; the nullable-`proposal_id` ledger change not
  weakening the proposal-driven exactly-once.
- Phase 5: consent bypass (the #516 class — a `deliverPartyShare` that hard-codes
  `recipientConsented:true` would be the SAME bug; it MUST read the registry
  fail-closed); kill-switch honored; suspended-org inert on deliver.

---

## 4. Phased build plan (each phase = one cohesive, disjoint slice)

Each phase names its canonical seam and is marked **BUILD-NOW** or **OWNER-GATED**.
Phases are dependency-ordered. Per CLAUDE.md §FEWER-COARSER-PRs, couple each BE
contract with its FE consumer onto ONE branch → ONE PR; gates stay per-change
(G-RT every security-sensitive phase, G-QA technophobe real-Chrome walk every
browser-observable phase).

### Phase 1 — Recipient identity + honest copy (X-1 + X-2 honesty half) — **BUILD-NOW**

- **Canonical seam:** the `external_share` schema + `CreateExternalShareInput`
  contract + the pgcrypto `encryptField`/`decryptField` PII pattern + the masked-
  PII serializer precedent.
- **Files (disjoint set):** additive migration (new nullable identity columns +
  `delivery_channel` + `last_delivered_at`); `external-share.ts` schema; shared-
  types contract (create input + view with masked contact + `deliveryStatus`);
  `external-shares.service.ts` create/toView; `share-sheet.tsx` (add WHO fields +
  channel picker); copy: replace the false `createdSent`/`resendDone` strings with
  HONEST ones gated on `deliveryStatus` ("הקישור מוכן — העתק ושלח" until real
  delivery exists). i18n namespace `externalShare`.
- **Outcome:** every share now records WHO; the UI never claims "sent" — it says
  "ready to copy / not yet delivered". The X-2 lie is removed even before real
  delivery exists.
- **Gates:** G-RT (PII masking, no national_id ingress), G-QA technophobe walk
  (manager can see WHO; copy is honest about non-delivery).

### Phase 2 — Org-wide situation-picture page + scope NAMES (X-3 + X-4) — **BUILD-NOW**

- **Canonical seam:** the portal scope-name-join (`portal.service.ts:227-284`,
  `projects.name`/`buildings.address`+`city`/`apartments.number`+`floor`); the
  keyset `list()` already wired (`external-shares.service.ts:561-585`); the
  situation-picture board primitives (documents party-binder / projects fleet).
- **Files (disjoint set):** `external-shares.service.ts` `list()` (resolve scope
  ids → `scopeLabel` via the join); shared-types view (`scopeLabel`); a NEW
  dashboard route/page (org-wide "גישות חיצוניות") built on the board primitives;
  move/retire the buried `ShareActivityPanel` mount (or keep a project-filtered
  variant); `notification-links.ts` add `externalShares()`.
- **Outcome:** a first-class, scannable, attention-first org-wide page; scope reads
  as a place, not a number; "not delivered" shares float to the top.
- **Gates:** G-RT (org-scope/RLS isolation on the new page; no scope-id oracle),
  G-QA technophobe walk AT SCALE (imagine/seed 100s of shares — does the manager
  grasp who-has-what-to-what in one glance? are the numbers correct?).

### Phase 3 — Party token tier + party-read portal (X-S4 structural) — **BUILD-NOW (no real outbound)**

- **Canonical seam:** clone `ShareTokenService` → `PartyTokenService` (audience
  `emapp-party`, dedicated secret, revocation-by-row); the existing
  `resolveDocumentAccess` → `decideExternalPartyAccess` retrieval resolver
  (UNCHANGED) for every party read; the contractor-portal guard pattern
  (`contractor-auth.guard.ts`) for the party guard.
- **Files (disjoint set):** `PartyTokenService`; a party-auth guard; party-portal
  read controller(s) verifying `emapp-party` and routing reads through the existing
  resolver; a "preview link" the manager can copy (the `manual_link` channel) — the
  token is minted, the portal works, but the link is **manager-delivered**, no
  email/SMS yet.
- **Outcome:** the share is actually REACHABLE (manual link), the party portal
  enforces the full fail-closed resolver incl. the OTP step-up gate, with ZERO
  real outbound. This proves the whole reach path before flipping delivery on.
- **Gates:** G-RT UNBOUNDED (token-confusion matrix, revoked/expired live re-check,
  cross-org, no-oracle), G-QA walk (manager copies a link; a real browser as the
  party reaches exactly the granted scope and is denied everything else).

### Phase 4 — Wire the delivery RAILS through `governOutboundSend` (dormant) — **BUILD-NOW (kill-switch OFF)**

- **Canonical seam:** `governOutboundSend` + the `outbound_ledger` (the M1 spine);
  the signature-reissue call-site as the template
  (`signature-requests.service.ts:2045-2074`); the notifications `emitMany` +
  `resolveNotificationRecipients` seam.
- **Files (disjoint set):** the SMALL additive ledger migration (nullable
  `proposal_id` + `cause` discriminator — see §2.2 note); `deliverPartyShare`
  gated domain method (the `send` thunk body — resolve+decrypt address at send
  time, call `IEmailProvider`/`ISMSProvider`, classify delivered/failed);
  `resend()` re-pointed to `governOutboundSend` with `recipientConsented` resolved
  **fail-closed** (registry-or-false), `killSwitchEnabled` from
  `CAMPAIGN_SEND_ENABLED`; `external_share_delivered` notification; set
  `last_delivered_at` only on real `sent`.
- **Posture:** ships with `CAMPAIGN_SEND_ENABLED` OFF and consent fail-closed →
  every governed send returns `blocked` → NOTHING is delivered. The code path is
  exercised by tests (blocked/failed/ambiguous/sent) but inert in prod.
- **Outcome:** the rails exist, exactly-once, consent-gated, kill-switched — but
  dormant. One owner action away from live.
- **Gates:** G-RT UNBOUNDED (consent-bypass = the #516 class; kill-switch honored;
  suspended-org inert; ledger exactly-once across the nullable-proposal change),
  G-QA walk in a forced-`sent` test env (the OUTCOME chain: provider record →
  `last_delivered_at` set → manager notification fires → status badge flips to
  「נמסר ✓」).

### Phase 5 — ACTIVATE real delivery to real external parties — **OWNER-GATED (P5)**

- **Why gated:** sending REAL outbound to REAL recipients is in the genuine-owner-
  gated set (CLAUDE.md §EXECUTION POSTURE #3). It also depends on the
  consent/opt-out registry (`recipient_opt_outs`), which is NOT built and is itself
  owner-gated (memory `project_autonomy_reissue_delivery_gap` / #512).
- **What waits for the owner (prepared one-click):**
  1. Approve + apply the consent/opt-out registry migration (or confirm the policy
     for first-contact invites — external parties have no prior consent record).
  2. Provision/confirm `SHARE_TOKEN_SECRET`/party secret + provider creds (Resend /
     Israeli SMS) in staging+prod Infisical.
  3. Flip `CAMPAIGN_SEND_ENABLED` on for external-share invites.
- **Prepared deliverable:** the exact migration + the env/runbook + a one-paragraph
  go/no-go, so the owner activates in one click. NOTHING auto-sends before that.
- **Gates:** the owner's final acceptance after the full G-RT + G-QA on Phases 1–4.

---

## 5. Decision summary for the owner

- **Build Phases 1–4 now** — they make the system HONEST (no more false "sent"),
  LEGIBLE (WHO has access to WHAT, by name, in one org-wide situation-picture), and
  READY (token tier + dormant delivery rails), with **zero real outbound** and the
  full security spine intact.
- **One shared-table touch needs your nod:** making `outbound_ledger.proposal_id`
  nullable + adding a `cause` discriminator, so external-share invites reuse the
  ONE ledger/governor instead of a parallel mechanism (§2.2). This is the
  reuse-not-reimplement choice; the alternative (a second ledger) is worse.
- **Phase 5 is yours to flip** — real email/SMS to real external parties is the
  genuine owner-gated step (consent registry + kill-switch + provider creds),
  prepared one-click.

Nothing here loosens authorization. The grant + ceiling + narrows-only + no-oracle

- suspended-inert + the ONE retrieval resolver are all preserved and reused; the
  work is identity, honesty, legibility, and honest delivery on the existing rails.
