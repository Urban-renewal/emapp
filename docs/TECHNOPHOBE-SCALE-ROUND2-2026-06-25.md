# Technophobe-at-scale audit — ROUND 2 (owners / contractors / share / portal / home / inbox / notifications / messages)

2026-06-25. Owner directive: default to PARALLEL dispatch. Ran 3 read-only scale-audits CONCURRENTLY
(free) over every surface not covered in round 1 (docs/projects/signatures). This is the consolidated
prioritized backlog + the disjoint-by-module wave plan. (Round 1 = docs/TECHNOPHOBE-SCALE-AUDIT-2026-06-24.md.)

## The recurring pattern: BUILT BE endpoints the FE never consumes

- **B1** — `GET /owners/search` (keyset name search) exists; owners list never calls it → 40-page scroll.
- **H3** — `GET /notifications/unread-count` (constant-time) exists; FE uses page-local counts + bell capped "5+".
  This is exactly what the manager-operating-model is meant to catch. Both are near-free FE wires.

## Prioritized gaps (severity = technophobe-at-scale experience)

| #   | Module              | Sev      | Gap                                                                                     | Smallest fix (reuse named seam)                                                              |
| --- | ------------------- | -------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| B1  | owners              | BLOCKER  | no search/filter → page 25-at-a-time in creation order                                  | wire existing `GET /owners/search` (FE-only)                                                 |
| B2  | owners              | BLOCKER  | holdouts (`pendingSignatureCount`) computed per-row but never sorted to top             | additive `sort=pending_desc` orderBy + chip                                                  |
| H3  | notifications       | HIGH     | unread count page-local; bell caps "5+"; true `unread-count` endpoint unused            | `useUnreadCount` → bell + page badge (FE-only)                                               |
| H1  | inbox               | HIGH     | "N pending" = page length (lies: 80→"25"); flat list, no kind-grouping                  | add `GET /proposals/pending-count` + group by `kind`                                         |
| H2  | inbox+notifications | HIGH     | pagination REPLACES page (grouping/filter/count see ≤25)                                | `useInfiniteQuery` accumulate; `?type=` server-side                                          |
| C-1 | contractors         | HIGH     | flat wall — no search/filter/group/sort at 100                                          | name search + `specialty` facet (mirror share `partyType` filter)                            |
| X-1 | external-share      | CRITICAL | a share has NO recipient identity — can't tell WHO has access                           | add `recipientLabel`(+email/phone) to row + create form                                      |
| X-2 | external-share      | CRITICAL | toasts "נשלח" but nothing delivered (no channel) — OUTCOME-gate violation               | SMALL now: honest copy + disable resend. REAL: recipient + `governOutboundSend` + X-S4 token |
| X-3 | external-share      | HIGH     | scope = raw count, not project/building NAME                                            | BE list joins scopeIds[0]→name (set-based)                                                   |
| X-4 | external-share      | HIGH     | no org-wide access page; buried in 1 project's docs tab, shows org-wide data mislabeled | top-level "שיתופים" page, reuse panel+hook                                                   |
| X-5 | external-share      | HIGH     | panel hard-caps 50, no pagination, silent truncation                                    | wire `has_more`/cursor (reuse ListPageShell)                                                 |
| M1a | apartments          | MAJOR    | no status filter/sort                                                                   | additive `status` where + chips                                                              |
| M1m | messages            | MED      | conversation list flat 50, no pagination (BE supports)                                  | `useInfiniteQuery`                                                                           |
| M2  | nav/sidebar         | MED      | no org-wide unread badges (inbox/notif/messages)                                        | badge from count endpoints                                                                   |
| M3  | messages            | MED      | no aggregate conversation-unread endpoint                                               | mirror `notifications.unreadCount`                                                           |
| m1  | apts/buildings      | MINOR    | scoped pages don't use `ListPageShell` (no access-denied branch)                        | route through ListPageShell                                                                  |
| L2  | home                | MINOR    | `needsHuman[]` (A8) wire bucket unsurfaced                                              | surface or document as dead                                                                  |
| —   | home                | CLEANUP  | `home-conversations.tsx` orphan (never imported)                                        | delete                                                                                       |

**Home mission-control PASSES at scale** (cap+tail honest + reachable, totalInScope honest, DataState legible,
one-click + voice-law fine). Tenant portal PASSES (single-resident scope). External-share SECURITY spine is strong.

## Dispatch plan — disjoint BY MODULE, waves of ≤2 concurrent builders (host crash-prone; P6)

Each module = one cohesive PR; modules are disjoint file sets → parallelizable. Wave 1 IN FLIGHT: **G4 (pulse perf)** +
**owners (B1+B2)**. Then, as each slot frees, dispatch next (each verified serially — G-RT + technophobe walk — before merge):

1. **notifications** (H3 + H2 accumulate) — near-free, high-value.
2. **inbox** (H1 count+group + H2 accumulate) — autonomy core; touches proposals BE (pending-count).
3. **contractors** (C-1 search/specialty-facet + C-3 edit).
4. **messages** (M1m pagination + M3 aggregate) + **apartments** (M1a status filter) — small, can pair.
5. **nav badges** (M2) — after the count endpoints (H1/H3/M3) land (depends on them; do last).
6. cleanup: delete `home-conversations.tsx` orphan; L2 needsHuman decision.

## Council-design + owner-gated (do NOT rush a builder)

- **External-share full redesign (X-1 + X-2-real + X-3 + X-4):** the "invite a party" feature is HALF-BUILT — no
  recipient identity, claims false delivery, no org-wide view. The real delivery (X-2) routes through
  `governOutboundSend`/OutboundGovernor + the unbuilt X-S4 party-token, and SENDING real outbound to real external
  parties is in the genuine-owner-gated set (P5). → convene a COUNCIL to design the holistic collaboration flow
  (CLAUDE.md "design customer processes with a council first"); owner decides delivery/timing. The SMALL X-2
  honesty-copy fix (stop claiming "sent") is buildable now and should land regardless.
- **M2 (project-level apartment rollup):** new aggregated read — council-design item, larger than a patch.
