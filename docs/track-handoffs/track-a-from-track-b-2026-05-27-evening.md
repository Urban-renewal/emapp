# Handoff: Track B → Track A (2026-05-27, evening)

> Self-contained second entry of the day. Read this if you're picking up Track A work after 2026-05-27 18:00.
> The morning entry (`track-a-from-track-b-2026-05-27.md`) covered worktree + heartbeats + serialize discipline; this one covers what BE shipped today and what handoff points are now live for you.

---

## TL;DR — Track B Phase 7 complete (V11 master plan v11.4 + v11.5 milestones satisfied)

Five PRs landed today since the morning handoff: **#125 B.S6** (Calendar/ICS), **#130 B.S7** (Calendar email), **#132 B.S8** (xlsx export), **#137 B.S9** (PDF export), **#138 B.S10** (export endpoint — in CI as of this writing). All Track B work in the V11 master plan is now done.

Cross-track items that affect you:

## 1. Your PR #136 export button now has a real endpoint behind it

PR **#138** (`feat(api): v11 b.s10 — project export endpoint`) wires `GET /api/v1/projects/:id/export?format=xlsx|pdf` against the exact contract you built `ExportXlsxButton` to call:

- Same URL: `/api/v1/projects/:id/export?format=xlsx`
- Same cookie auth (access_token)
- Same `attachment; filename=…; filename*=UTF-8''…` dual-form Content-Disposition
- Returns binary xlsx (Content-Type: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- 200 on success, 404 if project not found (your "not_ready" path stops firing once it merges)

**Action for you when #138 merges:** nothing to ship — your button transitions from `not_ready` → `ok` automatically. But you may want to re-run your A.S15 4-axis browser smoke against a real org + project in dev to confirm end-to-end. The MSW handler you wrote is identical to what the real endpoint emits, but the real path goes through cookie auth + throttle + the full project tree read (5-10s for big projects).

## 2. PDF format is also live — enable the second button

The disabled "ייצוא לPDF" placeholder on `ProjectPage` (with the `pdfComingSoon` tooltip you added in #136) can now be flipped on. The endpoint accepts `format=pdf` and returns `application/pdf` with the same RFC 5987 filename treatment.

If you want to ship the PDF button as a follow-up A-track slice:

- Same `ExportXlsxButton` pattern probably renamed to `ExportButton` with a `format` prop
- Same MSW handler with `format=pdf` branch (PDF magic bytes are `%PDF-1.4\n…`)
- Same 4-axis smoke
- Heebo font is base64-embedded in the PDF — recipients without Heebo installed still see correct Hebrew rendering

## 3. Calendar email is wired (B.S7 #130 merged)

`POST /api/v1/tasks` with `scheduledAt` set + at least one external attendee row in `task_external_attendees` fires a best-effort ICS email after the tx commits. The dispatcher:

- Hebrew subject prefix: `[הזמנה]` for create, `[עודכן]` for update, `[בוטל]` for cancel
- `event.ics` attachment with RFC 5545 `METHOD:REQUEST` or `METHOD:CANCEL`
- Owner with no email → skipped silently (column `ics_sent_at` stays NULL for the audit)
- Best-effort: a Resend rejection doesn't fail the task write

In dev, sends are captured in-memory via `FakeEmailProvider` (no real mail). In prod, you'd flip to `ResendEmailProvider` (one-line factory swap once Lidor provisions `RESEND_API_KEY` in Infisical).

**If you build the WeekCalendar UI:** the wire is `tasks.scheduledAt` + `tasks.location` (both nullable; if `scheduledAt` is null the email path no-ops, so non-calendar to-dos using `tasks` for storage are fine).

## 4. New rule binding ALL future Track B AND Track A smoke work

User caught me shipping #130 (B.S7) and #132 (B.S8) with only structural assertions — I had not actually opened the email payload nor the .xlsx file in a real reader. Decision (recorded in `memory/feedback_visual_smoke_gap.md`): the smoke step MUST include a visual/payload check, not just structural assertions. For your FE work this means:

- For new visual surfaces: real-browser screenshot (Playwright already wired for E2E in apps/web)
- For new download buttons: actually save the file + open it in a real reader (or render via headless chromium + screenshot)
- "Specs pass" ≠ "looks right"

This is already binding for Track B (B.S9 #137 + B.S10 #138 follow it). Worth aligning on the FE side too.

## 5. Two prod-only bugs caught by the new visual-smoke discipline

In case you hit either in your own work:

1. **`createRequire(__filename).resolve(…)`** — works in tsx/Vitest, breaks in webpack-bundled prod (`req.resolve` is undefined at runtime). Use `process.cwd()` + `node:fs.existsSync` for runtime asset discovery instead.
2. **`webpack-node-externals` misses some npm packages under pnpm's symlinked node_modules layout** — currently affects `playwright-core` and `exceljs`. They get inlined into `dist/main.js` and then crash on dynamic `require('./package.json')`. Fix: add an explicit externals entry in `apps/api/webpack.config.js`. (Not relevant for `apps/web` builds — Next.js handles externals differently — but worth knowing if you ever touch the API.)

## 6. POLICY.ts untouched all session (Gate-6 stays clean)

I did NOT touch `apps/api/src/common/authz/policy.ts` for any of the 5 PRs today. The Tenant Portal (B.S4 earlier) and the Export endpoint (B.S10) both mount under existing POLICY resources (`portal` lives outside the matrix entirely via TenantAuthGuard; `export` mounted under the existing `projects` resource since it's a read operation). So your earlier handoff item about Gate-6 still applies: I haven't introduced new authz surface that needs your review.

## What's safe / not safe for you (unchanged from morning handoff)

Re-check the morning entry `track-a-from-track-b-2026-05-27.md` § "What's safe for you to do without asking me" — all of it still holds. Nothing about your scope has changed; Track A still owns `apps/web/**` and I still won't touch it.

## Channel back

If you want me to pick up a specific BE follow-up (the agent-scope-to-assigned-projects known-debt on the export endpoint, the batched-decrypt perf if exports start blowing the T7.7 budget at scale, or anything else), leave a note at `docs/track-handoffs/track-b-from-track-a-<date>.md`. The current Track B sprint ends with B.S10 — no more open Track B PRs queued, so I'm available for whatever direction the user picks next.

Track B (BE) — 2026-05-27 evening
