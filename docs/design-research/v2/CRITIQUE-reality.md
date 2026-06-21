# CRITIQUE — Reality / Groundedness (v2 council second pass)

> **Role:** adversarial reality-check critic. The owner's exact concern is that
> the experts "came back too fast" and did NOT have the full picture. My mandate:
> re-open every real file each v2 expert doc cites, and verify the load-bearing
> claims are actually grounded in THIS codebase — not theorized from the brief,
> invented, or contradicted by the real code. I independently re-read the source
> for every claim rated below; nothing here is taken on the doc's word.
>
> **Verdict up front:** this second pass is *substantially* grounded. Unlike the
> v1 pass (which the owner correctly flagged as shallow), these eight docs cite
> real file:line evidence and, in the load-bearing cases I spot-checked, the
> evidence holds. I found **zero fabricated findings** and **zero claims
> contradicted by the code**. What I did find: a handful of **stale numbers**, one
> **cross-doc citation to standardize**, and — most importantly — a small number
> of **legal/domain assertions that are correctly flagged as owner/lawyer
> decisions but are stated with more confidence than a code-grounded doc can
> carry.** Those are the real residual risk, and they are already gated. Details
> below, per doc, with the exact file evidence I re-verified.

---

## 0. Method

For each doc I picked its **distinctive, load-bearing, falsifiable** claims (the
ones the synthesis will build on, and the ones most likely to be invented) and
re-read the cited source. I deliberately hunted for the failure mode the owner
fears: a confident claim the code does NOT support. Files I re-opened and
verified this pass (NOT trusting the doc's citation):

- `apps/api/src/modules/projects/projects.service.ts` (`signatureProgress`
  L355–435, `signatureProgressApartments` L456–526, `orgStats` L537–581)
- `apps/api/src/modules/projects/org-stats.controller.ts` (full)
- `apps/api/src/modules/signatures/signature-requests.service.ts`
  (`resend` L748, `resendForOwner` L927)
- `packages/shared-types/src/org-settings.ts` (`ConsentSettingsSchema` L118–125)
- `packages/shared-types/src/project.ts` (`ProjectStatsSchema` L219–229)
- `packages/db/src/schema/_enums.ts` (project type enum)
- `packages/db/migrations/` (0063, 0065 existence)
- `apps/web/src/components/ui/status-badge.tsx`
- `apps/web/src/models/project.vm.ts` (`statusColor` L28)
- `apps/web/tailwind.config.ts` (colors L82–135, borderRadius L136–139)
- `apps/web/src/app/globals.css` (`--r-lg` L102, `.badge-*` L262–306)
- `apps/web/src/app/[locale]/(dashboard)/_components/sidebar.tsx` (nav L113–145)
- `apps/web/src/app/[locale]/(dashboard)/_components/manager-home.tsx` (fetch L31–45)
- `apps/web/src/app/[locale]/(dashboard)/projects/[id]/project-detail.client.tsx` (tab L79)
- `apps/web/src/lib/api/signature-requests.ts` (export surface)
- `apps/web/src/app/[locale]/(dashboard)/_components/notifications-bell.tsx` (L81)
- `apps/web/src/messages/{he,en}.json` (line parity)
- grep sweeps: `'expired'` writes · `@Cron|ScheduleModule|setInterval` ·
  `Toaster|sonner|useToast` · `bg-card`

**Rating scale:** **Solid** (load-bearing claims verified, ship on it) · **Thin**
(directionally right but carries unverified/overstated claims to nail first) ·
**Unsupported** (a central claim the code contradicts).

---

## 1. `01-domain-workflow.md` — **SOLID** (one over-confident legal frame, correctly self-flagged)

Highest-stakes doc (drives the P0 consent decision), so I verified its spine
line-by-line.

**Verified TRUE against source:**
- The consent calc is a **binary, equal-weight apartment headcount** —
  `apartments_consented` counts apartments where `active_owners > 0 AND
  active_owners = signed_owners` (`projects.service.ts:398–399`); `consentedPct =
  round(apartmentsConsented/totalApartments*100)` (L419–420). **Nowhere** in the
  consent path is `share_numerator/denominator` read. Exactly as stated.
- `metThreshold = targetSignaturePct !== null && consentedPct >= targetSignaturePct`
  (L421) — verbatim. "Green bar is driven by a headcount, not share" is grounded.
- **NEW gap (a): `ConsentSettingsSchema` has only 3 keys** (`tama38_1`,
  `tama38_2`, `pinui_binui`) for a **4-value** type enum (`'other'` present in
  `_enums.ts:13`). Verified `org-settings.ts:118–125`. Real, previously
  unreported. Good catch.
- **NEW gap (b): the `'expired'` status is never written.** I grepped every
  `'expired'` hit under `apps/api/src`: all are token-verification, contractor
  share, OTP, or tests — **no path flips a `signature_request` to
  `status='expired'`.** Confirmed; lapsed links sit `pending` forever.
- Migration 0065 file exists. The integrity-trigger claim is consistent with the
  migration name and doc 05's independent reading.

**The one thing to watch (already correctly gated):** the headline — "EMAPP
counts consent in a way the law does not recognize" — blends a **verified code
fact** (calc is a headcount; share is stored-but-unused) with a **legal
assertion** (that share-weighting is the legally correct denominator). The code
fact is bulletproof. The legal claim is **domain expertise, not cited to a
statute**, and the doc *itself* flags it `[LEGAL — CONFIRM]` and routes it to an
owner/lawyer decision (§7). Correct posture. **My ask:** synthesis must not
promote the legal claim from "flagged" to "fact." The bug the council CAN assert
on its own authority is narrower and still decisive: **the app shows a single
bare "%" with no named denominator and gates its threshold on a basis (headcount)
that may differ from the basis the developer's lawyer uses.** That is provable
from the code alone and needs no adjudication of Israeli majority law. Frame it
that way.

**Verdict: SOLID.** Build on it; keep the legal % an owner/lawyer input.

---

## 2. `02-ux-lowtech.md` — **SOLID**

- **Project page opens on an empty `tenants` tab.** Verified
  `project-detail.client.tsx:79` = `useState<TabId>('tenants')`; `tabs` array
  (L117–122) orders tenants/docs/tasks/dashboard → board is 4th. TRUE.
- **`StatusBadge` bypasses the brand ramps.** Verified `status-badge.tsx:20–25`
  maps to Tailwind defaults (`bg-amber-100`/`bg-emerald-100`/`bg-red-100`/
  `bg-gray-100`), not `--warning/--success/--danger`. TRUE, high-leverage.
- **No toast/undo infra.** Grepped `Toaster|sonner|useToast|ToastProvider` →
  **zero hits.** TRUE.
- Its v1 self-correction ("test-chat already replaced by live HomeConversations")
  is corroborated by doc 03's independent read — honest delta, not invention.

**Minor:** I did not re-read every line of `signature-requests-list.client.tsx`,
but the "anonymous, actionless list" claim is consistent with the verified FE
data-layer gap (no resend wrapper, §6) and doc 06's independent read. Grounded.

**Verdict: SOLID.**

---

## 3. `03-information-architecture.md` — **SOLID** (one stale secondary number)

- **Sidebar is a flat 14-item dump.** Verified `sidebar.tsx:113–135`: 10
  always-on + Owners (gated) = up to 11, then `members`/`audit`/`settings` pushed
  (L137–145) = **up to 14**. Correct.
- **Threshold-distance sort is zero-BE today.** Verified `ProjectStatsSchema`
  (`shared-types/src/project.ts:219–225`) carries `signaturesPendingCount` +
  `signaturesSignedCount` (+ buildings/units/agents), merged into
  `ProjectListItemSchema` (L228). The precise v1 correction (distance-sort ships
  today; momentum-sort does NOT, no `lastSignatureAt`) is grounded.
- Board-on-4th-tab / default-tab — same verification as §2; TRUE.

**Stale number (flag for fix):** the doc cites `PCSidebar` as **"16 nav entries"**
(§0, §8-G3). The current `sidebar.tsx` comment (L146–149) says **"13 nav items, 4
groups."** Out of the org-tier scope the doc claims, so it changes no
recommendation — but correct it to 13 (or drop it) so synthesis doesn't
propagate it. Low severity.

**Verdict: SOLID.** The one inaccuracy is peripheral and out-of-scope.

---

## 4. `04-visual-design-system.md` — **SOLID** (its two NEW bugs are real)

Most aggressive new claims, so I tried hardest to falsify them.

- **`statusColor` leak is born in the DATA layer.** Verified `project.vm.ts:28`:
  `statusColor: 'gray' | 'amber' | 'emerald' | 'red'` ("Locked color palette").
  The literal Tailwind name is in the VM type, not just the component. TRUE — this
  reframing of v1 is correct and material (blast radius is VM + adapters + specs,
  not one file).
- **`bg-card` is a dead class.** I tried to disprove this (shadcn often defines
  `card` via a preset). Verified: `tailwind.config.ts` `theme.extend.colors`
  (L82–135) defines `border/background/foreground/primary/muted` + partner ramps
  — **no `card` color.** `card` appears only as a **safelisted global-class name**
  (L52), unrelated to the color utility. No `--card` var in `globals.css`. So
  `bg-card` resolves to no background. **The claim survives falsification — a real
  shipping bug**, used in **41 files** (grep-confirmed), incl. `list-skeleton.tsx`
  and `confirm-dialog.tsx`.
- **`--r-lg` contradicts itself.** Verified `globals.css:102` `--r-lg: 12px` vs
  `tailwind.config.ts:139` `lg: 'var(--radius)'` (`--radius: 0.5rem` = 8px). TRUE.
- **The `.badge-*` re-home target exists and is token-correct.** Verified
  `globals.css:268–306`: `.badge-success { background: var(--success-50) }` etc.
  So the recommended fix is buildable. (Also cross-corroborates docs 06/07/08.)

**Verdict: SOLID.** This doc earns its "deeper than v1" claim.

---

## 5. `05-data-feasibility.md` — **SOLID** (most rigorous; one shared cite to standardize)

Headline NEW finding is the autonomy-engine gap; verified independently:

- **No scheduler/cron anywhere in the API.** Grepped
  `@Cron|CronExpression|ScheduleModule|setInterval|nestjs/schedule` across
  `apps/api/src` → **one hit**, an unrelated `setInterval` in
  `imports-sse-cap.spec.ts:208` (a test). **Zero production time-driven jobs.**
  Airtight. This is the doc's most important finding.
- **`org-stats.controller.ts` has only `@Get('stats')`.** Verified (full read) —
  the pulse endpoint genuinely doesn't exist; `orgStats` is the right template
  (already has the agent-scope CTE). TRUE.
- **Migration 0063 added `'expired'`.** File exists:
  `0063_signature_request_expired_status.sql`. Correctly attributed.
- The EXISTS/DERIVABLE/NEEDS-DATA table is consistent with every schema/service
  fact I checked elsewhere; the "6/5/1-PII/1-migration" tally is grounded.

**Cross-doc cite to standardize (not a defect in 05):** docs 01, 03, 05 (and the
master plan / doc 07 §2.4) all reference the `'expired'` migration; they are
consistent on **0063**. Synthesis should standardize on 0063 everywhere so no
downstream slice cites a wrong number.

**Verdict: SOLID.** Anchor the data-feasibility synthesis here.

---

## 6. `06-interaction-motion.md` — **SOLID** (keystone claims all verified)

Its build sequence rests on "the resend endpoint exists; the FE never wraps it."
Both halves verified:

- **Backend `resend` exists** — `signature-requests.service.ts:748`. The **second**
  path the doc newly surfaces, **`resendForOwner`**, is at L927. Both real.
- **FE has no resend wrapper.** Read the export surface of
  `lib/api/signature-requests.ts`: list / get / fetchSignedDocument / create /
  retrieveLink / campaign / cancel. **No `resendSignatureRequest`.** Confirmed —
  the chase loop is a thin wrapper over an endpoint that exists, is tested, and is
  audited. The cheapest-honest-win thesis holds.
- **No toast/undo primitive** — same grep as §2; zero hits.

The doc is careful about the honesty fault-line (the "it'll keep nudging"
auto-cadence does NOT exist; ship the one-tap send first), which the
autonomy-engine gap (doc 05) confirms.

**Verdict: SOLID.**

---

## 7. `07-frontend-architecture.md` — **SOLID**

Distinctive owner-decision: "ManagerHome uses a SECOND ad-hoc fetch pattern."
Verified `manager-home.tsx:31–45`:

- Raw `fetch(`${base}/api/v1/org/stats`)` against
  `process.env['NEXT_INTERNAL_API_URL'] ?? 'http://localhost:3001'`,
  `cache: 'no-store'`, hand-forwarded `cookieHeader`, response **cast**
  `as { data: OrgStats }` — **no Zod parse, no TanStack seeding.** Exactly as
  described. Divergence from the dominant `prefetchToDehydratedState` pattern is
  real; "converge it" is a legitimate, correctly-scoped owner decision.
- The "list rows already carry counts → distance-triage is zero-BE" correction
  matches the `ProjectStatsSchema` verification in §3. Consistent.

**Verdict: SOLID.** Appropriately humble ("composition + tokens, not a rewrite").

---

## 8. `08-accessibility-i18n.md` — **SOLID**

- **i18n parity.** Both `he.json` and `en.json` are **1809 lines** (`wc -l`),
  consistent with "1491 keys each, exact parity, enforced by
  `app-i18n-key-coverage.spec.ts`." Grounded.
- **The one RTL physical-prop bug (G3).** Verified `notifications-bell.tsx:81`
  uses `-top-1 -right-1` (physical `-right`, should be `-end-1`). TRUE — and it is
  the *only* physical-direction hit the doc claims, matching the "~99%
  logical-clean" framing.
- **`StepUpDialog` lacks the focus-trap/ESC that `ConfirmDialog` has (G1)** —
  corroborated independently by doc 06's Finding D.2 (two docs, same file, same
  conclusion). Grounded.
- **The live-region gap (G6, §10).** Consistent with the verified
  no-toast/no-aria-live reality. The a11y framing of the autonomy doctrine ("a
  silent background action is inaudible to SR users") is a legitimate grounded
  extension, not an invention.

**Honest limitation the doc logs itself (good):** contrast ratios are computed
from token hex, NOT measured in rendered Chrome (§9), flagged `[UNVERIFIED]`. That
is appropriate humility, not a groundedness defect — but synthesis must carry the
"verify in real Chrome" gate forward.

**Verdict: SOLID.**

---

## 9. Cross-doc consistency check (the council agreeing with itself)

A second-pass council can fail by having eight docs that each cite the code
correctly but **disagree with each other**. I checked the load-bearing
cross-references; they are consistent:

- **Consent-counting bug** — asserted identically by docs 01, 02, 03, 04, 05, 07.
  All cite the same `signatureProgress` headcount + stored-but-unused
  `share_numerator/denominator`. **No contradiction.** All route the *legal* rule
  to an owner/lawyer decision and refuse to fake the headline number.
- **StatusBadge / `statusColor` leak** — docs 02, 03, 04, 07, 08 all name it; 04
  deepens it to the VM/adapter layer; all agree the `.badge-*` classes are the
  re-home target (which I verified exists). **Mutually reinforcing.**
- **No-scheduler / autonomy gap** — doc 05 finds it; docs 01 (`'expired'` never
  written) and 06 (`resend` manual-only, no `next_reminder_at`) independently
  corroborate from different files. **Three docs, one airtight conclusion.**
- **`'expired'` migration** — 0063 everywhere I checked. Consistent.

The only numeric drift is doc 03's stale "16" for PCSidebar vs the code's "13"
(§3) — peripheral and out-of-scope.

---

## 10. The real residual risks for the owner (what to watch in synthesis)

The owner's fear was "they didn't have the full picture." On groundedness, this
pass largely answers that fear — the code claims hold. The residual risks are NOT
fabrication; they are **three places where a flagged decision could be quietly
promoted to a fact:**

1. **The legal denominator (docs 01/05).** The council can assert, on its own
   authority, that *the app shows a bare % with no named denominator and gates on
   a basis that may not match the lawyer's.* It **cannot** assert which
   denominator is legally correct — that is `[LEGAL — CONFIRM]`. Keep it gated.
   This is the single most consequential claim in the whole research set; do not
   let board-first amplify a number the council has not (and cannot) legally
   verify.
2. **"DERIVABLE" ≠ "free."** Docs 03/05/07 correctly say momentum/pulse needs one
   new aggregate endpoint and the "why" needs a migration. The honest-build
   sequencing is right, but synthesis must preserve the **DO-NOT-FABRICATE
   contract** (doc 05 §4) verbatim — every "derivable" signal not yet on the wire
   is omitted, never shown empty or guessed, until its slice ships.
3. **Contrast + live-RTL claims are computed/static, not rendered.** Doc 08 is
   honest about this. Carry the "verify in real Chrome" gate forward; do not treat
   computed ratios as a passed audit.

---

## 11. Bottom line

| Doc | Rating | Must verify / correct |
|---|---|---|
| 01 domain-workflow | **SOLID** | Keep the *legal* denominator as `[LEGAL — CONFIRM]`; assert only the code-provable "unnamed-denominator / mismatched-basis" framing. |
| 02 ux-lowtech | **SOLID** | — (load-bearing claims verified) |
| 03 information-architecture | **SOLID** | Fix the stale PCSidebar "16" → 13 (peripheral). |
| 04 visual-design-system | **SOLID** | — (both NEW bugs survived falsification) |
| 05 data-feasibility | **SOLID** | Standardize the `'expired'` migration cite as 0063 across all docs. |
| 06 interaction-motion | **SOLID** | — (resend-exists / FE-gap / no-toast all verified) |
| 07 frontend-architecture | **SOLID** | — (the two-fetch-pattern finding is exact) |
| 08 accessibility-i18n | **SOLID** | Carry the "contrast computed, not rendered" caveat to the live-Chrome gate. |

**No doc rated Thin or Unsupported.** This is a genuine improvement over v1: every
doc cites real evidence and, where I re-read the source, the evidence holds. The
danger is no longer "they invented findings" — it is the subtler "a correctly
flagged legal/derivability decision gets rounded up to a fact in synthesis." Guard
those three seams (§10) and this research is safe to build on.
