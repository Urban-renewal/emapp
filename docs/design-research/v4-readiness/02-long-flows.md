# v4 Readiness — Front 02: The Long Multi-Step Flows (redesign + control + recovery)

**Auditor front:** the long/multi-step processes — new-project build, add-residents/Excel import,
campaign-send → public-sign, the chase/expiry loop, tabu extract/review, member/contractor/tenant
onboarding, document upload→serve.
**Method:** every claim below is grounded in the real code (Glob/Grep/Read), not the roadmap's lists.
**Date:** 2026-06-18.

---

## READINESS VERDICT (one line)

**AMBER — the flows are BUILT and individually robust, but the CONTROL layer over them is
half-present: the scheduler exists (refuting "no cron at all") yet there is NO proactive
chase/reminder, NO project-status transition guard, a LEGALLY-DIVERGENT consent number on the
portal, and several flows SILENTLY DROP the failures a manager must see at scale.** Design-complete,
control-incomplete — exactly the lead's thesis, with two of its premises partly wrong and three
confirmed worse than stated.

---

## GAP SUMMARY (ranked by production-impact at 50 customers × many projects)

| # | Gap | Severity | Evidence |
|---|-----|----------|----------|
| G1 | **No proactive chase/reminder job.** The clock only EXPIRES links; nothing nudges an unsigned owner. Every reminder is a manual `resend`/`getLink` click, one owner at a time. At scale the manager must manually track who hasn't signed across N projects. | **CRITICAL** | `packages/jobs/src` has `reaper`, `audit-retention`, `signature-expiry` jobs ONLY — `grep reminder\|chase\|nudge` = 0 hits. `signature-requests.service.ts:748 resend()` and `:852 getLink()` are manual, single-id. |
| G2 | **No project-status transition guard.** `projects.update` writes ANY status verbatim — `completed→planning`, `cancelled→in_construction`, skip-states all allowed. | **CRITICAL** | `projects.service.ts:773` `if (input.status !== undefined) patch.status = input.status;` — no state-machine check. Schema only enum-validates the VALUE (`project.ts:296 ProjectStatusEnum.optional()`), not the TRANSITION. |
| G3 | **Two divergent consent numbers; the portal one is legally misleading.** Manager board uses a defensible apartment denominator; the tenant/contractor portal shows `signed / links-sent`. Send to 10 of 35 owners, 10 sign → portal reads **100%**. | **CRITICAL** | Board: `projects.service.ts:419` `consentedPct = apartmentsConsented / totalApartments` (apartment "consented" only when `active_owners = signed_owners`, line 398-399). Portal: `apps/web/src/adapters/portal.ts:328` `signedPct = signaturesSigned / signaturesTotal`. **Neither uses ownership SHARES (רוב חתימות),** which is the actual תמ"א legal basis. |
| G4 | **Campaign/bulk send silently drops `failed`.** The campaign toast shows only `{created} sent · {skipped} skipped`; owners who failed (renter, not-associated-to-doc, PII-decrypt error) are computed server-side but never surfaced. | **HIGH** | `signature-campaign-action.tsx:48` `t('result', { created, skipped })` — no `failed`. Service DOES return per-owner failures (`signature-requests.service.ts:493-505`) but `createCampaign` (`:706-724`) sums only `created`/`skipped`, discards `failed`. A manager believes "everyone got it." |
| G5 | **Campaign requires a pre-existing FINALISED, project-scoped document** — a hidden multi-step prerequisite chain (create project → upload doc → wait for finalise → THEN campaign). No guided path; if no eligible doc exists the panel just says "no documents" with no next action. | **HIGH** | `signature-campaign-action.tsx:36` filters `!isArchived && projectId===projectId`; service rejects non-finalised (`uploaded_at IS NULL` → 404, `signature-requests.service.ts:122`) and apartment-scoped docs (`documentBelongsToProject` `:736`). |
| G6 | **Tabu extraction is a STUB — no real נסח parsing.** The whole extract→review→confirm flow runs on `StubExtractionProvider` (deterministic fake); a real engine is unimplemented. | **HIGH** | `tabu/extraction-provider.factory.ts:36` `return new StubExtractionProvider();` — "DETERMINISTIC … NO PII leaves the process," no real engine branch wired. |
| G7 | **SSE import-progress doesn't scale & has no server-push.** Each open stream polls `get()` every 500ms holding a pg client; hard per-pod cap of 30 streams → 503. Multi-pod count is unbounded only by `pods×30`. | **MEDIUM** | `imports.controller.ts:291 MAX_ACTIVE_STREAMS = 30`; header comment admits LISTEN/NOTIFY is the real fix ("§v8-S2 Phase 2"), not built. |
| G8 | **New-project wizard drops captured data on the wire (Gate-6 TODO).** Section `unitType` and `areaSqm` are collected, shown in review, then **silently discarded** before POST — user enters data that vanishes. | **MEDIUM** | `projects/new/page.tsx:273-278` TODO(gate-6): "we drop them on the wire." Review panel (`:1409`) shows area the BE never receives. |
| G9 | **Presigned-PUT 5-min TTL is a silent multi-step trap.** create-import → user picks file slowly → PUT 403s as a generic `upload_failed`; no resumable/refresh-url path. | **MEDIUM** | `imports/new/page.tsx:86-88` maps R2 403 → `upload_failed`; comment "presigned PUT TTL is 5min." |
| G10 | **Import preview→confirm is good, but cancel/back-out leaves orphan R2 bytes to a timed purge, not immediate.** | **LOW-MED** | `purge-import-bytes.ts` + reaper handle it on a clock; a cancelled import's bytes linger until the sweep. (Known flake: `imports.s8` R2-purge timing.) |
| G11 | **No concurrent-edit guard (optimistic locking) on projects/owners.** Two managers (or manager+agent) editing the same project last-write-wins; `update` reads `before` then writes patch with no version/updatedAt check. | **MEDIUM** | `projects.service.ts:767-803` — `select before` then `update … where id` with no `updatedAt`/version predicate. At 50 customers with 2-dev teams this WILL clobber. |

---

## FLOW-BY-FLOW WALK (current step-count · minimal-action redesign · CONTROL/ERROR/RECOVERY)

### 1. New-project creation — the 1468-line wizard
**File:** `apps/web/src/app/[locale]/(dashboard)/projects/new/page.tsx` (1468 lines, single component).
**Current steps:** 3-step wizard (Details → Structure → Review). Step 1 alone has name, type, consent %,
milestones list-editor, description, AND a P3 "renewal" fieldset (developer, תמורה ratio, relocation,
גוש-חלקה) — ~15 inputs before you reach buildings. Hydration-gated submit (`:334`, `:401`), double-fire
ref guard (`:343`), `CreateProjectInput.safeParse` boundary (`:406`).

- **Friction:** the wizard is heavy for the doctrine's "minimal create." There IS a `minimalCreateHint`
  (`:689`) saying name+type is enough — but the form presents the full enrichment fieldset inline anyway,
  contradicting "create empty, enrich later." A new יזם sees a wall.
- **Minimal-action redesign:** collapse step 1 to name + type + a single "advanced" disclosure. Default
  buildings from type (already partly done: tama38_1 auto-adds one building `:377`). Offer a "create &
  add residents" CTA that chains into import, so the empty project isn't a dead end.
- **CONTROL/ERROR/RECOVERY:**
  - **Data loss (G8):** section area/unitType captured + shown in review (`:1211`, `:1409`) then dropped
    (`:273`). The user's input silently evaporates. **Close before prod** — either persist it (schema/Gate-6)
    or stop collecting it.
  - **Back-out:** Cancel → `/projects` with NO draft persistence; all entry lost. No autosave. Acceptable
    for a 3-step form but jarring after filling 15 fields.
  - **Interrupted submit:** double-POST guarded (ref + `step!==3` + `!hydrated`, `:401`). Good.
  - **Server failure:** generic `createFailed` (`:421`) — anti-enumeration, but a manager can't tell a
    validation reject from a network blip. At scale this hides real misconfig.

### 2. Add-residents / Excel import (the SSE flow)
**Files:** `imports/new/page.tsx`, `imports/[id]/page.tsx`, `imports/[id]/mapping/page.tsx`,
`imports/[id]/errors/page.tsx`; `use-import-progress.ts`; `imports.controller.ts`; worker
`import-job.handler.ts`.
**Current steps:** pick project → pick file → (optional dry-run) → upload to presigned R2 PUT → poll detail
page → **awaiting_mapping** (open wizard) → **awaiting_confirm** (preview, nothing persisted) → confirm →
real load → done. That's **up to 6 manager touchpoints** with two pause-gates.

- **Strengths (genuinely good control):** preview-by-default (`requireConfirm`, `imports/new:79`) — a bad
  Excel is reviewed + cancellable before it touches the org; per-entity change-summary (`imports/[id]:151`);
  paginated row-errors; SSE live counters with TanStack invalidation on terminal (`use-import-progress:90`).
- **Minimal-action redesign:** auto-resolve mapping when the alias table + saved template hit (the ~80%
  common case, worker `mapping-resolver.ts` chain) so awaiting_mapping is SKIPPED silently; only stop for
  ambiguity. Keep the confirm gate (it's the real safety valve).
- **CONTROL/ERROR/RECOVERY:**
  - **Provider down (R2):** `storage_unavailable` surfaced (`imports/new:91`). Good.
  - **Slow upload (G9):** 5-min presign TTL → 403 → opaque `upload_failed`; no URL-refresh, must restart.
  - **Bad rows:** isolated to `import_job_errors`, batch continues — correct. Confirm/cancel both reachable
    from preview.
  - **SSE drop:** browser auto-reconnect; CLOSED → `stream_closed` → "lost connection — refresh" (`:131`).
    Acceptable, but no server-push (G7) means it doesn't scale past 30 concurrent streams/pod.
  - **Cancel/back-out:** orphan bytes purged on a CLOCK (G10), not immediately.
  - **National_id mandatory:** every imported owner must be hash-matchable (no shell owners) — correct per
    spec, but means a partial-data Excel (owners without ID) fails rows the manager may not expect.

### 3. Campaign send → public sign chain
**Files:** `signature-campaign.controller.ts`, `signature-requests.service.ts` (createCampaign `:632`,
createBulk `:406`, create `:247`, resend `:748`, getLink `:852`), `public-sign.controller.ts`,
`signature-campaign-action.tsx`.
**Current steps (manager):** project must already have a finalised project-scoped doc (G5) → open campaign
panel → pick doc → confirm → toast. Server derives ALL active owners, fans out via createBulk (chunked at
200), delivers email+SMS out-of-band with bounded concurrency (8). **This is the best-engineered flow** —
recipient-association gate (`:193`), renter gate, expired-dedup, PII decrypt isolated per-owner so one bad
owner can't abort the batch (`:557`).

- **Minimal-action redesign:** the "send to all unsigned in one tap" the prompt wants is ALREADY here
  (createCampaign). What's missing is the INVERSE convenience: "re-chase all unsigned" — there's no bulk
  resend, only per-id `resend`/`getLink`. Add a `createCampaign`-shaped re-send-to-unsigned.
- **CONTROL/ERROR/RECOVERY:**
  - **Silent failures (G4):** `failed` owners (renter/unassociated/decrypt) are dropped from the toast.
    A manager running a 35-owner campaign that creates 28 + skips 5 + **fails 2** sees "28 sent · 5 skipped"
    and never learns 2 owners got nothing. **This is the control gap that bites at scale.**
  - **Provider outage (SMS/email):** delivery is best-effort AFTER commit; per-channel report exists for
    single `create` (`:374`) but the CAMPAIGN path sums only created/skipped — delivery failures are
    invisible. The request row exists ("sent" in the manager's mind) even if SMS bounced.
  - **Expired link:** owner clicks a dead link → public-sign 404/expired. Recovery = manager `getLink`
    re-mint (`:852`) or owner self-resend in portal (`resendForOwner:927`). Both manual, both single-id.
  - **Double-sign race:** atomic single-use via `jti` swap + `WHERE status='pending'` (`:782`, cancel race
    `:1258`). Solid.
  - **Phone-less owner:** `getLink` out-of-band copy path (`:852`) — thoughtful edge handling.

### 4. Chase / reminder / expiry loop
**Files:** worker `signature-expiry.handler.ts` + `main.ts:293-320`; `packages/jobs/src/signature-expiry-job.ts`.
**What EXISTS:** pg-boss cron is REAL and running three sweeps — reaper hourly (`0 * * * *`),
audit-retention daily (`15 3 * * *`), signature-expiry hourly (`30 * * * *`, flips lapsed pending →
expired). **The lead's "no scheduler/cron at all" is REFUTED.**
**What's MISSING (G1):** the loop only EXPIRES. There is no job that, e.g., "for every pending request
older than 3 days, re-deliver" or "notify the manager of owners who haven't opened the link." The entire
chase burden is manual + per-owner. **This is the single biggest control gap** — a 50-customer book of
business cannot be chased by hand.
- **Redesign:** add a `reminder:unsigned` cron consumer (the infra is one `boss.schedule` + one handler away —
  the pattern is proven 3× in `main.ts`). Tier reminders (day 3 / 7 / pre-expiry). Roll a daily
  "your projects: X owners outstanding" manager digest.

### 5. Tabu extraction / review
**Files:** `tabu-extractions.controller.ts`, `extraction-provider.factory.ts`, `tabu-extraction-review`.
**Current steps:** create draft extraction → run extract (parse → encrypt → store rows) → PII step-up unlock
→ review rows (masked national_id) → edit rows → confirm (atomic owners-match/create + ownership replace
with provenance). The lifecycle + gates are **excellent** (draft-only writes, idempotent confirm 409,
mandatory human confirm per D — owner's chosen "auto-parse + MANDATORY human confirm").
- **CONTROL gap (G6):** the parser is a STUB (`factory.ts:36`). The whole human-review apparatus exists,
  but there is no real נסח extraction behind it — so in production it produces deterministic fake rows
  unless/until a real `IExtractionProvider` is wired. **Either ship manual entry as the honest path or
  build the engine before promising extraction.**

### 6. Onboarding — member / contractor / tenant
**Files:** `members.service.ts` (invite `:174`, accept `:719`), `accept-invite.controller.ts`;
`contractors.controller.ts` + `shares.controller.ts`; `auth/tenant/otp.controller.ts`.
- **Member invite:** JWT-based, `INVITE_TTL='7d'` (`members.service.ts:66`). Self-expiring — NO DB row to
  chase/expire, so no cron needed (clean). Resend exists (`members-resend-invite`).
- **Tenant:** SMS-OTP self-serve (D.20), own-record only. Suspension-aware (`otp-suspension`).
- **Contractor:** share-based token (`contractor/share/[token]/route.ts`), JSONB perms, read-tier excludes
  sensitive docs.
- **CONTROL/RECOVERY:** all three are short, self-contained, well-gated. **Lowest-risk flows.** Only nit:
  the contractor share link has the same "no proactive expiry-warning" pattern as signing links.

### 7. Document upload → scan → serve
**Files:** `documents.controller.ts`, `project-document-upload.tsx`, envelope-encryption (S7d).
- Content-path upload (no presign/finalise for sensitive docs), decrypt-stream download, EMAPPENC AES-GCM
  at rest. Step-up unlock gates sensitive serve.
- **CONTROL gap:** no AV/malware scan step in the chain (the "scan" in "upload→scan→serve" is ZIP-preflight
  for imports, not a document AV scan). At 50 customers accepting arbitrary uploads this is a real exposure
  to flag — but it's a security-front item; noting here as a missing step in the flow.

---

## CROSS-CUTTING CONTROL GAPS (the "production with 50 customers = chaos?" question)

1. **No operator console over the flows.** There is a provider-system-health controller and metrics, but
   no per-org operational view of "every in-flight import / pending campaign / outstanding signature /
   stuck draft." A manager's only lens is per-project navigation. At scale this IS chaos — the lead is right.
2. **Failures are computed but not surfaced** (G4, campaign delivery, decrypt warnings logged not shown).
   The system honestly KNOWS what failed; the UI doesn't tell the operator. The doctrine "never show a
   signal the backend can't back" is satisfied; its inverse ("always show a failure the backend DID detect")
   is violated.
3. **No transition discipline** (G2 projects; and signature requests rely on atomic guards but project
   lifecycle is a free-for-all). A `completed` project can be reopened with no audit-meaningful guard.
4. **No concurrency control** (G11) — last-write-wins on shared records in a 2-dev-team-per-org product.
5. **The clock only destroys** (expire/purge/retention), never **chases** (G1). Autonomy is half-built:
   the system cleans up after itself but doesn't drive the work forward on its own.

---

## THE SINGLE MOST IMPORTANT THING TO CLOSE

**Build the proactive chase/reminder cron + surface the failures the backend already detects (G1 + G4).**
The expiry infra proves the cron pattern works and is trivially extensible; adding a tiered
`reminder:unsigned` consumer + a manager "outstanding" digest converts the product from "manager manually
chases 35 owners × N projects by hand" into the doctrine's "the system does the work." Simultaneously,
showing `failed` counts (campaign/bulk/delivery) closes the honesty gap that, at 50 customers, turns
"sent" into silent non-delivery. These two together are what move the long flows from *design-complete* to
*control-complete*.
