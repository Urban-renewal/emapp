# 06 — Interaction & Motion (v2): turning the status "photo" into a "movie"

> **Second-pass, code-grounded — deepened 2026-06-18.** Where v1
> (`docs/design-research/06-competitive-patterns.md`) and the master plan
> theorized the chase loop and the "wow" moments from the brief, this doc
> specifies them **against the real primitives that exist in the repo today** —
> the mutation hooks, the (absent) toast/undo layer, `StepUpDialog`, the
> `ConfirmDialog`, and the actual signature-request lifecycle on the wire.
>
> This pass **re-opened every cited file** (not just trusted the v1 citation),
> verified each load-bearing claim, and added the things the first v2 draft
> under-specified: the **second** resend path (`resendForOwner`, portal-side),
> the precise dialog ergonomics (concurrent-waiter `settle`, the focus trap, the
> `StepUpDialog` a11y gap that `ConfirmDialog` closes), the campaign action's
> **actual** current shape (an inline expand-panel, *not yet* a ConfirmDialog),
> the `getQueriesData` snapshot mechanism the optimistic hooks rely on, expiry as
> the **only real clock** in the lifecycle, and the `Idempotency-Key` reality for
> a resend wrapper.
>
> Cardinal rule carried from the North Star: **never fake a signal, never fake
> motion.** A "+2 השבוע" momentum phrase or a "כמעט שם" celebration must fire on a
> real backend event, not a decorative animation. Motion here is *meaning made
> legible over time*, not sparkle.
>
> READ-ONLY analysis. Cites real files/lines verified this pass; proposes, does
> not implement.

---

## 0. What I actually found (the ground truth that reframes this whole layer)

Five findings from reading the code change the shape of the deliverable. They are
load-bearing — every recommendation below is downstream of them. Findings A–C are
the v1 spine (re-verified). D and E are new this pass.

### Finding A — There is **no toast / undo / notification infrastructure**. At all.

- No toast library (`sonner` / shadcn `Toaster`) is installed or mounted. Grep
  for `Toaster|ToastProvider|use-toast|useToast|sonner` across `apps/web/src`
  returns **nothing**. (Verified this pass.)
- What the codebase calls a "toast" is a **manually-managed inline
  `role="status"` `<p>`** that the component renders from its own `useState` and
  that **never auto-dismisses and carries no undo**. The canonical example is
  `signature-campaign-action.tsx` — `const [toast, setToast] =
  useState<string|null>(null)`, set on success in `onConfirm()`, cleared only on
  the *next* action (`setToast(null)` at the top of the next `onConfirm`). The
  success line `role="status" aria-live="polite"` (the `{toast}` block at the
  bottom of that file) therefore **lingers on screen indefinitely** until the
  manager acts again. `step-up-unlock.tsx` (the `error` line,
  `style={{ color: 'var(--danger-700)' }}`) and `tabu-review-section.tsx` use the
  same hand-rolled inline-line pattern. The `step-up-unlock.tsx` header comment
  itself states: *"No dialog/toast primitive exists in this repo … this is the
  first true modal; it follows the same inline-status conventions (role="status"
  lines, var(--danger-700) palette, no toast lib)."*
- The repo's **first and only true modal primitives** are `StepUpDialog`
  (`components/step-up-unlock.tsx`) and the newer `ConfirmDialog`
  (`components/ui/confirm-dialog.tsx`). Both follow the same hand-rolled
  `fixed inset-0 z-50` overlay + `bg-black/50` backdrop + click-to-dismiss +
  `Button` primitive pattern. `ConfirmDialog` adds the proper
  `role="alertdialog"` a11y contract that `StepUpDialog` lacks (see Finding D).

**Consequence:** the North Star's "undo over confirm" rule (`02-ux-lowtech.md`
§2.5) and three of the five "wow" moments **cannot be built today** — the
substrate doesn't exist. The single highest-leverage interaction slice is to
**build the missing undo-toast primitive** (the `ActionToast` below), because the
entire chase loop and the calm-relief feeling hang off it. This is the gap v1
didn't surface because it didn't read for the *absence*.

### Finding B — The backend **already has a clean "remind" action**, but the FE doesn't expose it.

- The chase loop's core verb — *remind a holdout* — maps to a **real, audited,
  state-machine-guarded backend endpoint that already exists**:
  `POST /api/v1/signature-requests/:id/resend`
  (`signature-requests.controller.ts`; service `resend()`,
  `signature-requests.service.ts:748–830`, read in full this pass). It:
  - re-mints a fresh token via `tokenService.sign(...)` → **new `jti` + new 7-day
    `expiresAt`** (`:772`);
  - **atomically** swaps the row `UPDATE … SET { jti, expiresAt } WHERE id = :id
    AND status = 'pending' … RETURNING` (`:779–783`) — so the old link dies, the
    clock restarts, and a concurrent sign/cancel race that already moved the row
    out of `pending` yields **no row** → a second 409 (`:784–786`);
  - re-derives recipient PII inside the tenant tx (`loadOwnerWithPii`,
    `loadVisibleDocument`, `resolveFromForOrg`) and **re-delivers** via
    `deliverSignatureLink(this.email, this.sms, …)` (`:815–827`);
  - **audits** `signature_request.resend` (`:788–796`);
  - enforces the same coarse + fine authz as create — agent
    document-visibility (`assertDocVisibleForAgent`) then
    `requireAgentCapability(tx, user, 'manage_signatures')` (`:765–766`); Manager
    passes;
  - 409s (`signature_request_not_pending`) **up front** on a signed/cancelled
    request (`:767–769`) — i.e. the state machine is enforced server-side, twice.
- **But the FE never calls it.** `lib/api/signature-requests.ts` exposes only
  `listSignatureRequests`, `getSignatureRequest`, `fetchSignedDocument`,
  `createSignatureRequest`, `retrieveSignatureLink`, `createSignatureCampaign`,
  `cancelSignatureRequest` (verified the export list this pass). There is **no
  `resendSignatureRequest`** and **no `useResendSignatureRequest` hook**
  (`hooks/use-signature-requests.ts` has list / one / create / link / campaign /
  cancel only — the whole file is 132 lines, read in full). The one-tap holdout
  chase the North Star wants is a **thin FE wrapper over an endpoint that's
  already built, tested, and audited.**

**Consequence:** the "one-tap holdout chase" wow moment is the *cheapest* of the
five to ship honestly — it's an api wrapper + a hook + a button + the toast from
Finding A. No migration, no new backend.

### Finding C — There are **no motion tokens** and **no `prefers-reduced-motion` guard**.

- `apps/web/src/app/globals.css` contains exactly **two** transition
  declarations — `transition: background 0.12s, border-color 0.12s, color 0.12s`
  on buttons and `transition: border-color 0.12s, box-shadow 0.12s` on inputs.
  There are **no `@keyframes`, no `--duration-*`/`--ease-*` tokens, and no
  `@media (prefers-reduced-motion: reduce)` block** anywhere. (Verified this
  pass; the reality critic independently re-verified the absence.)
- The only "motion" in the app is Tailwind's `animate-pulse` used for skeletons
  (e.g. `signature-progress-apartments.tsx:67`, the campaign panel's loading bar,
  step-up's busy states). It is a loading affordance, not decoration.

**Consequence:** the master plan's principle 5 ("built to be re-skinned") must
extend to **motion tokens** (`--motion-duration-*`, `--motion-ease-*`) so the
owner's designer tunes the *feel* without touching components — AND so we ship a
`prefers-reduced-motion` guard from day one (an accessibility + low-tech-comfort
requirement: a fearful user does not want things flying around). This is a small
addition to the `04-visual-design-system` token work, owned jointly.

### Finding D — There are **two** resend paths, and the modal-a11y contract is **inconsistent** between the two existing dialogs.

New this pass — neither was in the v1 draft.

**D.1 — A second resend exists: `resendForOwner` (portal / tenant-driven).**
`signature-requests.service.ts:927 resendForOwner(...)` is called from
`portal.controller.ts:132` — the **tenant** self-service path (an owner in the
SMS-OTP portal asking for their own link again), distinct from the **manager**
`resend(...)` at `:748`. It re-mints a fresh token + 7-day expiry and atomically
swaps `jti+expiresAt WHERE id AND owner_id AND status='pending'`
(`signature-requests-resend-for-owner.spec.ts:13–14`). **Implication for this
layer:** the manager chase loop and the tenant self-resend can **both** rotate
the same request's `jti`/`expiresAt`. The FE's optimistic "expires in 7 days"
label must therefore treat the server's returned `expiresAt` as authoritative and
reconcile on invalidation — never assume the manager's resend is the last writer.
This is a subtle correctness note the v1 draft missed.

**D.2 — `StepUpDialog` and `ConfirmDialog` do NOT share the same a11y contract.**
Both are hand-rolled `fixed inset-0 z-50` modals, but:
- `ConfirmDialog` (`confirm-dialog.tsx`) is the **gold standard**:
  `role="alertdialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`
  (`:197–200`); **ESC closes** → resolves `false` (`:162–165`); a **Tab focus
  trap** that wraps within the dialog (`:167–183`); **initial focus to the SAFE
  (cancel) button** (`:154–156`); backdrop click = cancel (`:205`).
- `StepUpDialog` (`step-up-unlock.tsx`) is **weaker**: `role="dialog"` (not
  `alertdialog`), `aria-labelledby` but **no `aria-describedby`**; **no ESC
  handler**, **no Tab focus trap** (it relies on `autoFocus` on the code input
  only, `:249`); backdrop click = cancel (`:208`). The accessibility doc (08)
  flags this same gap (G1: retrofit `StepUpDialog`).

**Implication for this layer:** the new `ActionToast` and any new modal MUST be
built to the `ConfirmDialog` contract (ESC, focus management, `alertdialog`/
`status` roles), **not** the `StepUpDialog` one. And both dialogs share a
**concurrent-waiter `settle`/`resolve` pattern** worth copying exactly (Finding
E.2) — that pattern is what makes "one dialog, many callers" safe.

### Finding E — The optimistic pattern is real, proven **twice**, and rests on a specific `getQueriesData` snapshot mechanism the signature mutations don't use.

Sharpened this pass — the v1 draft cited apartment-status but missed the second
precedent and the exact snapshot/restore mechanics.

**E.1 — TWO shipped, tested optimistic precedents (not one):**
1. `useUpdateApartmentStatus` (`use-apartments.ts:97–124`) with the pure
   transform `applyApartmentStatus` (`apartment-optimistic.ts`, + `.spec.ts`).
2. **`notifications-optimistic.ts`** (`applyMarkRead` / `applyMarkAllRead`,
   + `notifications-optimistic.spec.ts`) — the *same* recipe for notification
   mark-read. Its header comment is the template doctrine verbatim: *"return a
   NEW page (immutable …) … only touch UNREAD rows, so a re-applied or
   double-fired mutation is a no-op … `at` is passed in (not `new Date()` here) so
   the hook controls the timestamp and tests stay deterministic."*

**E.2 — The exact snapshot/restore mechanism** (so the new hook copies it, not a
re-invented one): `useUpdateApartmentStatus.onMutate`:
`await qc.cancelQueries({ queryKey })` → `const prev =
qc.getQueriesData<...>({ queryKey })` (snapshots **every** matching cache entry,
detail + every list page) → `qc.setQueriesData(..., (old) =>
applyApartmentStatus(old, ...))` → returns `{ prev }`. `onError` restores via
`ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data))`. `onSettled`
`invalidateQueries`. The **inverse for undo is literally this `prev` snapshot** —
the undo toast does not need a separate "un-do mutation" for status changes; it
re-applies the snapshot the optimistic hook already captured.

**E.3 — The signature mutations are NOT optimistic.** `useCreateSignatureRequest`,
`useCancelSignatureRequest`, `useCreateSignatureCampaign`, `useRetrieveSignatureLink`
(`use-signature-requests.ts:74–131`) **only** `invalidateQueries` on success — so
the holdout's row does **not** flip until the refetch lands (a visible lag on the
exact action that needs to feel instant for the chase loop).

**Consequence:** the chase loop's "feels instant" requirement is satisfiable
*today* with a pattern shipped twice — we extend, not invent.

---

## 1. The motion philosophy for THIS user (calm momentum, not animation)

The North Star principle 4 — *"a status board is a photo; a manager needs a
movie"* — is **not** a request for animation. For a low-tech, fear-driven user,
gratuitous motion is the opposite of calm. The "movie" he needs is **state that
changes truthfully over time and is narrated in plain words** — momentum
("+2 השבוע"), staleness ("אין תנועה 18 יום"), and the moment a milestone is
crossed. Most of that "movie" is **copy and data**, delivered by the pulse
endpoint (`05-data-feasibility.md`), not CSS.

So this layer has two distinct jobs, and they must not be confused:

1. **Narrative motion (the movie) — data + copy.** Momentum / stall / threshold
   phrases. Buildable now from `signed_at` aggregates. This is where ~90% of the
   "movie" value lives. It needs the pulse endpoint, not animation.
2. **Micro-motion (the feel) — restrained, tokenized, reduced-motion-safe.** The
   *transition* of state: a count ticking up, a card settling into a new
   position, the threshold bar filling to the marker, the gentle settle of a
   "needs you now" card. This serves *legibility of change* ("something just
   happened, here's what"), never decoration.

**The governing rule:** every animation must answer *"what state changed?"* If it
doesn't mark a real state transition, cut it. And all of it respects
`prefers-reduced-motion`: under `reduce`, transitions become instant, the
celebration becomes a static badge, nothing moves, nothing loops.

---

## 2. The undo-over-confirm layer — the missing primitive, specified

This is the foundational slice. The North Star (`02-ux-lowtech.md` §2.5) is
emphatic: confirmation dialogs *train this user to fear his own clicks*. The
codebase today has a `ConfirmDialog` (good, for the few truly-destructive cases)
but **no undo toast** for the common reversible case. So today every reversible
action either silently succeeds with a non-dismissing inline line (campaign
action) or would reach for the confirm dialog. We need to invert the default.

### 2.1 The decision rule (what gets undo vs. confirm vs. nothing)

Ground it in `archivedAt` soft-delete (CLAUDE.md: soft-delete = `archivedAt`,
verb = ארכוב) and the real action inventory.

| Action | Reversible? | Real-people side-effect? | Pattern |
|---|---|---|---|
| **Send reminder** (`resend`, Finding B) | the *send* isn't, but per-owner it's low-stakes & expected | yes (1 owner) | **Undo toast** with a short *pre-send hold* (§2.3) — NOT a dialog |
| **Mark apartment status** (`useUpdateApartmentStatus`) | yes (just flips a field) | no | **Optimistic + undo toast**; already optimistic today, the `prev` snapshot IS the undo (Finding E.2) |
| **Archive project / owner / doc** (`archivedAt`) | yes (un-archive exists) | no | **Optimistic + undo toast**, NOT the confirm dialog |
| **Cancel a signature request** (`cancel`) | partially (re-create / re-mint needed) | no (kills a pending link) | **Undo toast** (re-create on undo) OR confirm — owner call (§7-D5) |
| **Send a campaign to ALL active owners** | NO | yes (N owners, real SMS/email) | **ConfirmDialog** — the one justified confirm (calm summary + one button) |
| **PII reveal** (national_id / phone) | n/a (read) | no | **StepUpDialog** (already correct flow; close the a11y gap, Finding D.2) |

> The litmus from the North Star: *confirm ONLY when destructive **and**
> irreversible **and** high-stakes.* Under `archivedAt`, almost nothing the
> manager does is truly irreversible. The **only** routine confirm that survives
> is the multi-owner campaign send — real messages to real people's phones.

### 2.2 The `ActionToast` primitive (proposed — mirrors the existing modal hooks)

Build it to mirror the exact ergonomics the team already adopted twice
(`useConfirm`, `useStepUpUnlock`): a hook that owns state + a `toast` node
rendered once in the tree. This keeps it idiomatic and re-skinnable.

```
const toast = useActionToast();
// ...
toast.show({
  message: t('reminderSent', { name }),   // "נשלח לאורי"  (no future-nudge copy until §7-D2)
  undo: () => cancelResend(),             // optional; presence of `undo` shows the בטל affordance
  durationMs: 6000,                       // auto-dismiss; pauses on hover/focus (a11y)
  tone: 'success' | 'info' | 'danger',
});
// ...
return <>{...} {toast.node}</>;
```

Requirements (all grounded in repo conventions):

- **`role="status" aria-live="polite"`** — the *same* a11y contract the inline
  lines already use (e.g. `signature-campaign-action.tsx`'s `{toast}` block).
  Danger tone uses `aria-live="assertive"`. This is NOT a new a11y pattern; it's
  the existing one, promoted to a reusable, auto-dismissing, undo-bearing
  component. (Do NOT make the toast a `dialog`/`alertdialog` — it must not steal
  focus from the page; it's a passive announcement with one reachable button.)
- **Tokens only** — `var(--success-700)` / `var(--danger-700)` / `var(--bg-surface)`
  / `var(--border)` exactly as the campaign toast does today. No hardcoded color
  (re-skin rule). Add the motion tokens from §6.
- **Auto-dismiss with pause-on-hover/focus** — 6s default; the timer pauses while
  the pointer is over the toast or it has keyboard focus (so the בטל is always
  reachable — a fearful user reads slowly).
- **Undo is a real inverse action**, not a UI trick — it calls the actual inverse
  mutation (un-archive, re-create, restore prior status). For the apartment-status
  case the inverse is **trivially the `prev` snapshot the optimistic hook already
  keeps** (Finding E.2) — no new endpoint.
- **Concurrent-waiter discipline** — copy the `useStepUpUnlock`/`useConfirm`
  pattern: one toast region, a controller that owns the timer + the pending undo,
  and a `settle()` that is idempotent if already dismissed (mirrors
  `createConfirmController.resolve` and `useStepUpUnlock.settle`). This prevents a
  double-dismiss or a stale-undo firing twice.
- **Single toast region**, bottom-trailing in RTL (`02-ux-lowtech.md`: primary
  action in the thumb arc). Concurrent toasts stack; max ~3 visible.
- **Reduced-motion:** under `prefers-reduced-motion: reduce`, the toast appears
  instantly (no slide-in), still auto-dismisses.

**Owner decision surfaced (§7-D1):** the *pre-send hold* for reminders — do we
delay the actual `resend` POST by the toast window (true undo, no message sent if
undone) or fire immediately and treat "undo" as "we already sent; here's the link
to retract manually" (the send is irreversible once delivered)? The honest
options differ in user trust; see §7.

### 2.3 Replace the existing non-dismissing inline "toasts" — and **upgrade the campaign action while we're there**

`signature-campaign-action.tsx` is the clearest papercut, and it is **not** what
the v1 draft implied. Verified this pass: it is **not** a ConfirmDialog today — it
is an **inline expand-panel** (`open` state) with a document `<select>` and a
direct `onConfirm()` button that calls `campaign.mutateAsync(...)` with **no
confirmation step at all**, then sets a **non-dismissing** `role="status"` success
line `{created} נשלחו · {skipped} דולגו` that lingers until the next action.

So the campaign action needs **two** changes, not one:
1. **Add the one justified confirm** (§2.1) — fan-out to N real phones is the one
   action that should narrate-and-confirm (`נשלח ל-N בעלים` — see Wow 5, §4).
2. **Migrate its lingering success line to `ActionToast`** (`tone:'success'`, no
   undo — a delivered campaign is the confirmed irreversible action).

Same migration for `tabu-review-section.tsx` and the provider suspension panel:
one primitive, ~4 bespoke call-sites collapsed.

---

## 3. The ONE chase loop (identical from every surface) — concrete spec

The North Star demands the chase be **identical** whether the manager starts it
from the home triage card, the project "מי תקוע" list, or an apartment's owner
line (`02-ux-lowtech.md` §9.4). Below is that single loop, specified against the
real endpoint (Finding B) and the real surfaces.

### 3.1 The shared api wrapper + hook (the single source of the loop)

First the **api wrapper** (`lib/api/signature-requests.ts`), and it MUST use
`postIdempotent` — verified this pass that `createSignatureRequest` and
`createSignatureCampaign` already go through `apiClient.postIdempotent`
(auto-mint Idempotency-Key), precisely to guard the double-click on a send. A
resend re-delivers to a real owner and rotates the `jti` **twice** on a
double-fire, so it belongs in that same guarded class:

```
// proposed: lib/api/signature-requests.ts (next to retrieveSignatureLink)
export async function resendSignatureRequest(id: string): Promise<SignatureRequestCreateResponse> {
  const res = await apiClient.postIdempotent<unknown>(`/signature-requests/${id}/resend`, {});
  return SignatureRequestCreateResponseSchema.parse((res as { data: unknown }).data); // defensive Zod parse (ARCHITECTURE-MAP §1)
}
```

Then the **hook**, mirroring `useRetrieveSignatureLink` *exactly* (same
invalidation reasoning, same 0-retry rationale):

```
// proposed: hooks/use-signature-requests.ts (sits next to useCancelSignatureRequest)
export function useRemindSignatureRequest() {
  const qc = useQueryClient();
  return useMutation<SignatureRequestCreateResponse, Error, string>({
    mutationFn: (id) => resendSignatureRequest(id),   // POST :id/resend  (Finding B)
    // Optimistic flip + snapshot (the §5 extension) goes here.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: SIGREQ_KEY });
      qc.invalidateQueries({ queryKey: ['projects'] }); // expiry/clock moved → board + pulse refetch
    },
    // 0 retries (mutation default). Re-firing a resend that may have succeeded
    // re-delivers to the owner AND rotates jti again — the Idempotency-Key on the
    // POST is what makes the unavoidable double-click safe, not a retry policy.
  });
}
```

This mirrors `useRetrieveSignatureLink` (`use-signature-requests.ts:94–102`) — same
invalidation reasoning ("the old link is dead; `expiresAt` moved"), same 0-retry
rationale. It's a known-safe pattern, not a new one.

### 3.2 The loop, step by step (the same 4 beats everywhere)

1. **One tap: `שלח תזכורת`.** Inline on the holdout's row/card. No dialog — it's a
   single-owner, expected, low-stakes send (§2.1). The button is the *one primary
   action* on that row; everything else (reveal phone via StepUp, open owner) is
   quiet.
2. **Optimistic state flip + `ActionToast`.** The owner's line immediately reads
   `נשלחה תזכורת — ממתין` (optimistic, the §5 extension), and the toast says
   `נשלח לאורי` with `בטל`. **Do NOT show any "נזכיר שוב בעוד 3 ימים" copy** — see
   §3.3; that promise is not real yet.
3. **The send commits and the clock resets.** `resend` returns the row with the
   **new `expiresAt`** (now+7d). Note both the manager `resend` and the tenant
   `resendForOwner` (Finding D.1) can move this clock — treat the server's
   returned `expiresAt` as authoritative.
4. **State stays legible everywhere.** Every surface that shows this owner now
   reads `נשלחה תזכורת — ממתין · פג בעוד 7 ימים` (expiry from the re-minted
   `expires_at` — the **only real "clock" in the lifecycle**, see §3.3).

### 3.3 The honesty fault-line in the chase loop (must read)

The North Star's wow #3 ("it'll keep nudging for me," `02-ux-lowtech.md` §7.3)
and §9.4 step 2 **both assume an automatic recurring reminder cadence**. **That
job does not exist in the codebase.** Verified this pass: a grep for
`Cron|@Cron|setInterval|ScheduleModule|worker|scheduler` across `apps/api/src`
returns only incidental hits (the exception filter, R2 storage, export, imports
controller) — **no reminder scheduler**, **no `next_reminder_at` column**, **no
`reminder_schedule` table**. `resend` is a **manual, manager-initiated, one-shot**
re-delivery; `resendForOwner` is a **tenant-initiated** one-shot. The **only**
time-based mechanism in the whole lifecycle is the **7-day `expiresAt`**, enforced
at sign time (`public-sign.service.ts:118` rejects `expiresAt <= now()`). There is
no automatic nudge before expiry.

So there are two honest paths, and this is an **owner decision (§7-D2)**:

- **(a) Ship the loop WITHOUT the auto-promise now.** The toast says `נשלח לאורי`
  — true, shippable today, still a one-tap relief. The manager re-taps when he
  wants. No fabrication.
- **(b) Build the auto-cadence as a backend slice first** — a `next_reminder_at`
  column + a worker (the repo has **no** scheduler today, so this is genuinely
  new infra: a NestJS `ScheduleModule`/cron or a Railway worker tick) that
  re-`resend`s on a cadence until signed/expired. Bigger, but it's the *actual*
  relief the North Star describes, and it's also what makes "the system does the
  work in the background" (the central doctrine §b) literally true.

**Recommendation:** ship (a) immediately (the cheap honest win), surface (b) to
the owner as the follow-up that makes wow #3 — and the doctrine's "act in the
background, notify don't task" — real. Do NOT show the "נזכיר שוב" sentence until
(b) lands.

### 3.4 Where the loop is identical (the three entry points)

- **Home triage card** (the ~5 "needs you now", powered by the proposed pulse
  endpoint, `05-data-feasibility`) — the holdout chase button is on the card.
- **Project page → "מי תקוע"** — the per-apartment drill
  (`signature-progress-apartments.tsx`) currently shows the apartment
  designation + `{signed}/{total} חתמו` + a status chip and **no action**
  (verified: the `<li>` rows render `t('row', …)` + `<StatusBadge>` only, no
  button, no owner name, no request id). Add the same `שלח תזכורת` per
  partial/none row. **Caveat (real data gap):** that endpoint returns **no owner
  name and no request id** today, so a *one-tap, owner-named* chase from this
  surface needs the small authorized per-apartment owner read
  (`05-data-feasibility`). Until then, the chase from this surface is
  **apartment-grained** (open the apartment → chase the named holdout there), not
  one-tap from the drill row.
- **Owner / apartment detail** — same button on the owner's signature-request row.

All three import `useRemindSignatureRequest` + `useActionToast`. The button, the
optimistic flip, and the toast copy come from **one shared
`<RemindHoldoutButton requestId={...} ownerName={...} />`** component, so the
loop is *structurally* identical, not just visually similar.

---

## 4. The ~5 engineered "wow" moments — feasibility + spec

The North Star lists five (`02-ux-lowtech.md` §7). Here is each, graded against
the real data/primitives, with a concrete build.

### Wow 1 — "כמעט שם" finish-line moment ✅ BUILDABLE NOW (count) / ⚠️ owner-named send needs a read
- **Trigger (real):** `SignatureProgress.metThreshold === false` AND
  apartments-remaining-to-threshold ≤ 1, computed from
  `apartmentsConsented`/`totalApartments`/`targetSignaturePct`
  (`projects.service.ts`; see `05-data-feasibility`). All on the wire.
- **Build:** when a project card / project header computes "one away," it renders
  the warm phrase `כמעט שם — חסרה חתימה אחת` + a single `שלח תזכורת אחרונה` that
  runs the §3 chase against the last holdout. The threshold bar
  (`signature-progress-bar.tsx`) animates its fill to the marker on mount
  (motion §6); reduced-motion → static.
- **Honesty:** "the last holdout" requires knowing *which* owner is unsigned — the
  per-apartment owner read again. If unavailable, the phrase still fires (the
  count is real) but the button opens the project's holdout list instead of a
  one-tap send. **Never invent the name.**

### Wow 2 — "crossed the line" threshold celebration ✅ BUILDABLE (on-screen edge), needs a seam
- **Trigger (real):** `metThreshold` flips `false → true`. The boolean is computed
  server-side and present on every list row — so the FE can detect the
  **transition** by diffing the previous cached value against the new one after an
  invalidation (the chase loop already invalidates `['projects']`).
- **Build:** a small `useThresholdCrossed(projectId)` that watches the cached
  `metThreshold` and fires once on the `false → true` edge → a **calm, dignified**
  celebration (NOT confetti for this user): the bar turns `var(--success-600)`, a
  one-line `עברת את הסף בפרויקט {name} — {signed} מתוך {target}`, auto-dismissing
  via `ActionToast` (`tone:'success'`). Reduced-motion: the bar simply *is* green,
  no fill animation, the line still shows.
- **Caveat (real):** the edge-detection is **client-cache-based** — it fires only
  while the manager is looking and the cache updates. It will NOT fire for a
  crossing that happened while he was away — there is **no** server-emitted
  "milestone reached" event/notification today (the `notifications` table emits no
  such row; confirmed by absence). **Owner decision §7-D3:** is the on-screen edge
  enough, or do we want a real server-emitted "threshold reached" notification (a
  backend + `notifications` slice)? Ship the on-screen edge now; flag the
  notification as the richer follow-up.

### Wow 3 — the one-tap holdout chase ✅ BUILDABLE NOW (the cheapest win)
- This IS §3. The endpoint exists (Finding B); it needs the api wrapper
  (`postIdempotent`) + hook + button + toast. The "it'll keep nudging" half is
  gated on §3.3-(b) — ship the honest one-tap send first.

### Wow 4 — the calm-home reward ✅ BUILDABLE (data) — pure copy/state
- **Trigger (real):** the pulse endpoint's `attention` list is empty (no project
  needs you) — i.e. the triage zone has 0 items.
- **Build:** instead of an empty void, the home's triage zone renders the reward
  state `הכול רגוע היום — אין משהו דחוף. {N} פרויקטים זזים יפה.` (`02-ux-lowtech`).
  The `{N} זזים יפה` count is real (projects with positive `signedThisWeek` from
  the pulse). This is **not animation** — it's an empty-state that *rewards*. A
  single gentle one-time fade-in on the reassurance line (reduced-motion: none).
- **Dependency:** the pulse endpoint. Until it ships, the home can't compute
  "nothing urgent" honestly. (The current manager home has flat KPIs + a
  **calendar empty-state stub** and a live conversations panel — the stubs are the
  anti-pattern to kill, not a reward state. See `02-ux-lowtech`.)

### Wow 5 — "already thought for you" campaign ⚠️ PARTIALLY BUILDABLE
- **The North Star vision:** open "new signature request" with **all unsigned
  owners pre-selected** and the copy pre-written — a decision to confirm, not a
  form to assemble (`02-ux-lowtech`; central doctrine §a).
- **Reality (verified this pass):** the campaign endpoint **derives the recipient
  list server-side** (all active owners of the project) — the FE doesn't assemble
  it. `signature-campaign-action.tsx`'s `onConfirm()` sends only
  `{ documentId: selectedDocId }`; the manager picks a *document* (from a
  project-scoped `<select>`) and the server fans out. There is **no** "only the
  unsigned" filter and **no** per-owner review on the wire; the success line even
  reports `{created} נשלחו · {skipped} דולגו` (the server decides who's skipped).
  So "pre-selected unsigned owners as a reviewable list" does not match the
  current server-derives-everything design.
- **Honest build now:** wrap the existing campaign send in the one justified
  ConfirmDialog (§2.3) that **narrates what it will do** before sending —
  `נשלח ל-{N} בעלים שטרם חתמו` (the unsigned count is derivable from
  `signaturesPending`). That's the "already thought for you" feeling **without** a
  fabricated per-owner picker.
- **Owner decision §7-D4:** do we want a *true* reviewable "only unsigned,
  pre-selected, editable" campaign (needs the endpoint to accept a recipient list
  + a per-owner signed/unsigned read), or is "narrate the derived send" enough?
  The latter is shippable now and honest.

### Wow budget
The North Star caps at five and says *resist a sixth*. I concur — and I'd note
that **Wow 3 + the `ActionToast` undo are the foundation**; the other four are
copy/state layered on real data. Build the primitive first; the rest are cheap.

---

## 5. Optimistic updates — the pattern that exists twice, and where to extend it

The repo has **two** correct, fully-implemented, unit-tested optimistic mutation
families (Finding E.1): `useUpdateApartmentStatus` (+ `applyApartmentStatus`) and
`notifications-optimistic` (`applyMarkRead`/`applyMarkAllRead`). Both are textbook:
`cancelQueries` → snapshot `prev` via `getQueriesData` → `setQueriesData`
immutably → rollback on error → `invalidateQueries` on settle; both patch every
relevant cache shape and inject `at` so tests stay deterministic. This is the
template.

**The signature mutations are NOT optimistic** (Finding E.3) — so the holdout's
row does not flip until the refetch lands, a visible lag on the exact action that
needs to feel instant for the chase loop.

**Recommendation:** give `useRemindSignatureRequest` (and `useCancel…`) the same
optimistic treatment:
- Extract a pure `applySignatureRequestStatus(cache, id, patch)` mirroring
  `applyApartmentStatus`, in its own file with a node-env `.spec.ts` (the repo
  already tests both `apartment-optimistic.spec.ts` and
  `notifications-optimistic.spec.ts` this way).
- On remind: optimistically set the row to `נשלחה תזכורת — ממתין` + bump
  `expiresAt` to now+7d (matches what `resend` does server-side, `:772–783`),
  snapshot via `getQueriesData` for rollback (the snapshot **is** the undo).
- On cancel: optimistically flip to `cancelled`, rollback on the 409
  (`signature_request_not_pending`).

This makes the chase loop feel instant (the whole point of §3.2 beat 2) using a
pattern the team has already shipped and tested twice.

---

## 6. Motion tokens + reduced-motion (the re-skinnable "feel" layer)

To honor principle 5 (re-skinnable) AND ship accessible motion, add a tiny motion
token set to the `04-visual-design-system` token work (owned jointly). Today there
is **nothing** (Finding C).

```
:root {
  --motion-duration-fast: 120ms;   /* matches the existing button 0.12s */
  --motion-duration-base: 200ms;
  --motion-duration-slow: 360ms;   /* bar-fill, count-up */
  --motion-ease-out: cubic-bezier(0.2, 0, 0, 1);
  --motion-ease-spring: cubic-bezier(0.2, 0.8, 0.2, 1);
}
@media (prefers-reduced-motion: reduce) {
  :root { --motion-duration-fast: 0ms; --motion-duration-base: 0ms; --motion-duration-slow: 0ms; }
  /* components that key off these tokens become instant automatically */
}
```

Components consume **only the tokens** (never literal `0.12s`), so the designer
re-tunes the entire app's feel from `:root`, and reduced-motion zeroes durations
globally without touching a single component. The five places motion appears:

1. **Threshold bar fill** (`signature-progress-bar.tsx`) — `width` transition at
   `--motion-duration-slow --motion-ease-out`. Reduced-motion: snaps. (Marks: "we
   moved toward the line.")
2. **Count-up** on the finish-line / pulse counts — only on a *real change*, ≤
   `--motion-duration-slow`. Reduced-motion: shows the final number. (Marks: "+1.")
3. **`ActionToast`** slide-in from the trailing edge at `--motion-duration-base`.
   Reduced-motion: appears in place.
4. **Triage card "needs you now"** — a *very* subtle one-time settle/highlight when
   a card enters the urgent set (NOT a looping pulse — looping motion stresses a
   fearful user). Reduced-motion: a static accent border instead.
5. **Threshold-crossed (Wow 2)** — the bar color cross-fade to success.
   Reduced-motion: instant color.

**Hard rule:** no looping/infinite animation anywhere except the existing
`animate-pulse` skeleton (a loading affordance, which should itself respect
reduced-motion). Nothing bounces, nothing draws attention on a loop. Calm.

---

## 7. Owner decisions surfaced (do not guess these)

- **D1 — Reminder undo semantics.** Does `שלח תזכורת` (a) delay the `resend` POST
  by the ~6s toast window so "בטל" truly prevents the send (no message goes out),
  or (b) fire immediately, with "בטל" being best-effort/absent because an SMS once
  delivered can't be recalled? (a) is more honest "undo," costs a small send
  delay; (b) is instant but the undo is partly theater. **My lean: (a)** — for
  this user, "I can take it back" beats "it sent a half-second faster."
- **D2 — Auto-reminder cadence (the "it'll keep nudging for me" promise).** It
  does NOT exist today, and the repo has **no scheduler at all** (§3.3) — so this
  is genuinely new infra, not just a column. Ship the honest one-tap send now (no
  future-nudge copy), and approve/deny the backend slice (`next_reminder_at` +
  cron/worker) that makes wow #3 — and the doctrine's "act in the background" —
  real. **Blocking for the "נזכיר שוב בעוד 3 ימים" sentence: must not be shown
  until built.**
- **D3 — Threshold-crossed: on-screen edge vs. server notification.** The
  client-cache edge-detection (Wow 2) fires only while the manager is watching. Do
  we also want a real server-emitted "threshold reached" notification (a backend +
  `notifications` slice) so he learns of a crossing that happened while away? Ship
  the on-screen edge now; the notification is the richer follow-up.
- **D4 — "Already thought for you" campaign depth.** Narrate the server-derived
  send (`נשלח ל-N בעלים שטרם חתמו`, shippable now) vs. a true reviewable/editable
  "only-unsigned, pre-selected" picker (needs the endpoint to accept a recipient
  list + a per-owner signed read). **My lean: narrate now**, revisit the picker
  only if the manager actually wants per-owner control.
- **D5 — Confirm inventory + cancel semantics.** Confirm that the ONLY routine
  confirm dialog is the multi-owner campaign send (real SMS to N phones), and that
  archive / status-change move to optimistic-with-undo (§2.1). **And** decide
  cancel-a-request: undo-toast (re-create on בטל) vs. confirm. This is a
  behavioral change from "every destructive action used `window.confirm`"
  (`confirm-dialog.tsx` header: it replaced ~18 native-confirm call-sites) — worth
  an explicit owner sign-off.
- **D6 — `StepUpDialog` a11y retrofit (cross-ref doc 08 G1).** The PII step-up
  modal lacks ESC + a focus trap + `aria-describedby` that `ConfirmDialog` has
  (Finding D.2). Small fix, but it's the modal a fearful user hits when revealing a
  phone number — worth doing as part of this layer's "every modal to one
  contract." (Not strictly an owner *decision* — flagging for scheduling.)

---

## 8. Concrete slice plan (interaction/motion, sequenced by leverage)

| # | Slice | Builds on | Honesty status | Owner gate |
|---|---|---|---|---|
| **M0** | **`useActionToast` + `ActionToast`** primitive (auto-dismiss, pause-on-hover, undo, tokens, `role=status`, concurrent-waiter `settle`); migrate the ~4 bespoke inline "toasts" to it | mirrors `useConfirm`/`useStepUpUnlock` | n/a (pure UI primitive) | D1, D5 |
| **M1** | **Motion tokens + `prefers-reduced-motion`** in globals.css/token layer | joint with `04-visual-design-system` | n/a | — |
| **M2** | **The chase loop:** `resendSignatureRequest` api wrapper (**`postIdempotent`**) + `useRemindSignatureRequest` (optimistic, the §5 extension) + shared `<RemindHoldoutButton>`; wire into all 3 surfaces | Finding B (endpoint exists), M0, §5 pattern | honest one-tap send; **no auto-nudge copy** until D2 | D2 |
| **M3** | **Wow 1 (כמעט שם) + Wow 2 (crossed the line)** — finish-line phrase + threshold-bar fill + on-screen edge celebration | `metThreshold` (exists), M1, M2 | honest (real boolean + edge) | D3 |
| **M4** | **Wow 4 (calm-home reward)** + optimistic signature-mutation cleanup | pulse endpoint, M0 | honest (pulse data) | — |
| **M5** | **Wow 5 (campaign narration)** — wrap the campaign send in ConfirmDialog with `נשלח ל-N שטרם חתמו`, migrate its lingering line to ActionToast | `signaturesPending` (exists) | honest narration | D4 |
| **M6** | **StepUpDialog a11y retrofit** (ESC + focus trap + `aria-describedby`, to the ConfirmDialog contract) | Finding D.2 / doc 08 G1 | n/a | D6 (schedule) |
| **(BE)** | Auto-reminder cadence: scheduler/worker + `next_reminder_at` (unlocks wow #3 full copy + "background work" doctrine) | — (NEW infra: no scheduler today) | the only NEW backend for this layer | D2 |

**M0 + M2 are the keystone:** they deliver the single highest-emotional-value
interaction (one-tap chase with safe undo) on an endpoint that already exists,
using patterns the team has already shipped twice. Everything else layers on.

---

## 9. Source map (files actually read/verified for this doc, this pass)

- Mutation hooks / optimistic precedents: `apps/web/src/hooks/use-signature-requests.ts`
  (read in full, 132 lines), `…/use-apartments.ts:85–124`,
  `…/apartment-optimistic.ts` (+ `.spec.ts`), `…/notifications-optimistic.ts`
  (+ `.spec.ts`).
- Chase endpoint (FE gap): `apps/web/src/lib/api/signature-requests.ts` (export
  list verified — no `resend`; `create`/`campaign` use `postIdempotent`). Backend:
  `apps/api/src/modules/signatures/signature-requests.service.ts:748–830` (`resend`,
  read in full) + `:927 resendForOwner` (second path) →
  `apps/api/src/modules/portal/portal.controller.ts:132`. Expiry enforcement:
  `…/signatures/public-sign.service.ts:118,278`.
- No scheduler: grep `Cron|@Cron|setInterval|ScheduleModule|worker|scheduler` over
  `apps/api/src` → only incidental hits (filter, storage, export, imports), **no
  reminder cron** (verified).
- Modal/confirm/step-up primitives: `apps/web/src/components/ui/confirm-dialog.tsx`
  (read in full — `alertdialog`, ESC, focus trap, focus-to-cancel, concurrent
  `resolve`), `…/components/step-up-unlock.tsx` (read in full — `dialog`, no ESC,
  no trap; the a11y gap).
- The "toast" reality + campaign send UX: `apps/web/src/app/[locale]/(dashboard)/
  projects/[id]/_components/signature-campaign-action.tsx` (read in full — inline
  expand-panel, `{documentId}`-only body, non-dismissing `role=status` line).
- Holdout drill surface (no name/id/action): `…/_components/
  signature-progress-apartments.tsx` (read in full).
- Motion/tokens absence: `apps/web/src/app/globals.css` (only 2× `0.12s`, no
  keyframes, no reduced-motion).
- Cross-refs: `docs/design-research/v2/05-data-feasibility.md` (distance,
  metThreshold, velocity, stalled, pulse endpoint), `…/v2/08-accessibility-i18n.md`
  (G1 StepUpDialog a11y gap), `…/v2/CRITIQUE-reality.md` (independent
  re-verification of Findings A–C). North Star: `docs/DESIGN-NORTH-STAR.md`,
  `…/v2/02-ux-lowtech.md` (§2.5, §6, §7, §9.4).
