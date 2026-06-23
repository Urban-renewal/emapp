# Signatures "flat wall" → high-scale situation-picture — build plan

Owner-flagged 2026-06-23: the signatures list is a flat undifferentiated wall; must read at
HIGH SCALE (many projects) and feel modern. Plan from a fresh-context Plan agent.

## Diagnosis (file:line)

- `apps/web/src/app/[locale]/(dashboard)/signature-requests/signature-requests-list.client.tsx`
  is one `<ul>` of identical cards (L88-114), raw created-at-DESC order, **no grouping, no
  attention-ranking**; rows show only a status badge + relative time — **no project / owner /
  apartment / document name** → a wall of near-identical timestamps at N=hundreds. Single
  status toggle (L14-19, 68-83); load-more cursor (L116-125); only zoom is `/signature-requests/[id]`.
- Root cause is ALSO the wire: `SignatureRequestSchema` (packages/shared-types/src/signature-request.ts:30-43)
  carries only `documentId`/`ownerId` UUIDs; `ListSignatureRequestsQuery` (L206-214) has **no
  projectId filter**; BE `list()` (apps/api/.../signature-requests.service.ts:1558-1626) does **no joins**.
- **The fix is mostly reuse:** `mission-control-home.tsx` (E2.1/#44) already groups by attention,
  ranks most-urgent-first, shows a pulse sentence + fleet grid + consent slivers + holdout
  drill-down + one-click chase. Apply that pattern to the signatures surface.

## Target (recommendation: group by PROJECT, attention-ranked — matches the home)

- **Tier 0 Pulse header** — reuse `buildPulseSentence` + `useSignaturePulse` buckets, signatures-scoped.
- **Tier 1 "צריך טיפול"** — ranked attention project groups (server `rankAttention`): name, reason chip,
  `ThresholdSliver` consent bar, pending/expiring count, holdout drill-down + chase (`useChaseHoldout`).
- **Tier 2 fleet** — full project list as compact zoom-in tiles (capped + "הצג הכל").
- View toggle: צריך טיפול (default) | כל הפרויקטים | **כל הבקשות** (the existing flat list, preserved for forensics).
- Zoom path: pulse → attention group → project tile → `/projects/[id]` (already-built per-project board) → request detail.

## Slices (each carries G-QA[+latency<1s][+SCALE-READY][+legibility] + G-RT where PII/scope)

- **Slice 1 (FE-only, NO BE, NO PII) — reframe as the 3-tier board** by extracting the reusable
  primitives from `mission-control-home.tsx` (`ActionCard`,`HoldoutExpander`,`HoldoutRow`,`FleetTile`,
  `buildPulseSentence`) into a shared `_components/` module (refactor-extract, ONE source of truth —
  avoid the 59-site dup class) + composing them on the signatures page; server-prefetch
  `getSignaturePulse()`; preserve the flat list under "כל הבקשות". Data: all existing
  (`org/signature-pulse`, holdouts, chase, list). **Biggest win, ships standalone.**
- **Slice 2 (BE, security-sensitive → mandatory G-RT)** — enrich `list()` with LEFT JOINs for
  projectName/apartmentLabel/documentName + **masked-by-default owner name (only behind
  `view_owner_pii`, mirror B4 holdout gate)**; add `projectId` filter. New `SignatureRequestListItemSchema`
  (do NOT add PII to base schema). api-docs ENDPOINTS entry. Watch keyset ms-vs-micros cursor bug. @security before commit.
- **Slice 3 (FE)** — consume Slice 2: legible flat rows (project·owner(masked)·document·status) +
  project filter + sort; `<NameDisplay>` wrap; stub new query params in any route-mocking e2e.
- **Slice 4 (FE polish)** — all-clear reward (`DataState`), agent-scope verify, density toggle.

Sequencing: Slice 1 standalone now; 2→3 paired (BE→FE); 1 ‖ 2 parallel tracks; 4 independent.

## Defaults for open questions (don't block)

- Grouping = by-project attention-ranked (alt: by-status kanban only on owner steer).
- Keep flat list as secondary forensic view = yes. Owner names = masked-default behind `view_owner_pii`.
- No new pulse fields needed (the VM already carries buckets/cards/fleet/consent/kill-switch).
