# Product audit — change plan (2026-06-25)

First full run of `PRODUCT-AUDIT-HARNESS.md`, scored against `DEFINITION-OF-PERFECT.md` (C1–C8). 4 read-only
role/scale audits (contractor · tenant · agent · fleet). This is the **finite NO-list** — the build queue.
Drive it to all-green, re-audit, done. Each item: fix (named canonical seam) · severity · buildable-now vs
owner-gated. (`B` = buildable now; `OG` = owner-gated — real outbound / token tier / migration.)

## Matrix verdict by role

- **Agent — STRONG** (mostly PASS: scoping/PII/capabilities are exemplary, real own situation-picture). 1 systemic gap.
- **Fleet (manager) — MIXED.** Home/documents/signatures/inbox/notifications = reference-quality rollups. Tasks/Members/Contractors = flat walls; the home rolls up ONE axis (signatures) only.
- **Tenant — BROKEN at the core** (can't sign from the portal; multi-project residents mishandled; dead-ends).
- **Contractor — effectively NO product** (read-only, one-project-per-token, no identity, no upload, delivers nothing).

## Ranked build queue

### TIER 1 — biggest experience delta, buildable now

1. **[B, BLOCKER] Tenant: one-click sign FROM the portal.** Add an attention-first band at the top ("יש לך N בקשות
   חתימה ממתינות") + a prominent per-row CTA that fires `resendForOwner`→`deliverSignatureLink` (the seam already
   delivers) with plain copy. Demote the marketing hero. _Fixes C1/C4/A6 — the resident's #1 job is currently impossible._
2. **[B, MAJOR] Tenant: honest, project-aware top + multi-project.** Drive hero status from `project.statusLabel`
   (stop hard-coding "פעיל/בעיצומו" — lies in planning/cancelled); group apartments/signatures/docs BY project (69
   real multi-project residents) reusing the board project-grouping primitive. _C1/C3/C6._
3. **[B, MAJOR] Agent: gate the 9 `/<entity>/new` create routes.** Wrap each `(dashboard)/*/new/page.tsx` in the
   canonical `PermissionGate` (gate on the same effective-permission the list CTA uses) + a legible "no permission —
   ask your manager" fallback. **Prioritize `owners/new`** (renders national_id/phone inputs to an agent who can't
   create owners). One cohesive PR. _C4/C5/C6._
4. **[B, MAJOR] Fleet: cross-axis "fleet health" on the home.** The home rolls up signatures only. Fold
   `boardCompleteness.projectsBehindTotal` (docs) + a new tasks-overdue aggregate into the `signaturePulse.buckets`/
   `FleetSection` (the canonical fleet seam) so the portfolio picture reflects ALL risk axes. _The owner's core
   "project-level not many-projects" gap. C1/C2/C3._

### TIER 2 — closes flat-walls + dead-ends, buildable now

5. **[B, MAJOR] Fleet: a tasks situation-picture.** Tasks is the worst flat wall (no filter/rollup/grouping). Add
   overdue/due-soon/blocked buckets + project grouping (board primitives) + fold overdue into the home pulse. _C1/C2._
6. **[B, MED] Fleet: per-list rollup headers** on Projects-list (buckets summary above the list, chips carry counts)
   - Owners (needs-attention risk rollup). Reuse `signaturePulse.buckets`. _C1/C2._
7. **[B, MED] Fleet: team-workload view (Members)** — agent × assigned-projects + pending load + unassigned-projects
   flag, over `project_assignments` (the join orgStats/pulse already use). _C2/C6 — staffing at scale._
8. **[B, MED] Agent: `(dashboard)/error.tsx` boundary** (calm forbidden/error panel, mirror the inbox `DataState`
   forbidden copy) + legible empty owner-picker on `signature-requests/new` when `view_owners` is absent. _C5._
9. **[B, MED] Tenant: close the dead-ends** — tenant-scoped document download (BE already scopes docs to owned
   apartments); honest delivery-result from `SignatureDeliveryReport` (which channel/masked number, real failure
   copy); retry on section errors; `?reason=session_expired` on the auth bounce; one real contact channel
   (`resolveFromForOrg`); wire the "coming soon" tenant role-picker entry to `/tenant/login`. _C4/C5/C7._
10. **[B, MAJOR] Contractor: read-only → situation-picture + two-way upload.** Within the existing per-project share:
    reuse the documents situation-picture primitives (grouping/attention) AND add a party-scoped `upload` capability
    to the `external_shares` perms JSONB routed through the documents presigned-PUT + scan-gate + `decideExternalPartyAccess`.
    _Turns a dead brochure into a hand-off. C1/C6/C7._

### TIER 3 — owner-gated (prepare one-click; you decide timing)

11. **[OG] Contractor: identity + fleet portal.** A contractor account/session tier (the unbuilt X-S4 party token,
    generalized) → a fleet board of all their engagements. Needs the token tier + unify on `external_shares` (cut the
    legacy `shares` JWT path over — X-S8). Real cross-party delivery via `governOutboundSend` = real outbound (OG).
12. **[OG] External-share real delivery** (`resend` currently only audits) — `governOutboundSend` + X-S4 token. Already
    in the round-2 ledger as owner-gated council-design.
13. **[OG, prepared] #498 sensitive-doc backfill** (runbook ready) · **#512 consent registry** (Gate-6, G-RT clean).

### Cleanup (low)

14. Delete the `home-conversations.tsx` orphan; decide `L2 needsHuman[]` surface-or-document; legacy `orgStats` (4
    portfolio KPIs computed, shown nowhere) — surface or drop.

## Convergence

This is the NO-list v1. Build Tier-1 → re-run the harness → the NO-count must drop → repeat through Tier-2, then the
owner-gated Tier-3 on your timing. All-green against C1–C8 (every page × role) = DONE. You verify any cell with the
5-second test. Re-audit after each wave; the matrix is the single source of "are we there yet."
