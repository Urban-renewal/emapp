# EMAPP — Away-Run Handoff (2026-06-26)

The autonomous run built the **buildable-now plan to the final acceptance bar and verified it**; the
rest is genuinely owner-gated (schema/migration/real-outbound) and is documented one-click-ready.
`gh pr list --state open` shows **only the owner-gated set** — every non-gated PR is merged.

## ✅ Merged to main this run (~35 PRs, all gate-passed)

- **Security (red-team-driven):** signing-JWT out of req.url/Sentry/edge logs · env-fail-closed
  (NODE_ENV/SMS/OTP/throttler) · OTP atomic brute-force lockout · cross-entity archive-revokes-access ·
  delivery-outcome honesty · transient-vs-terminal error states · **export full-PII re-asserts
  `owners.reveal_pii` (#593)** · **consent fail-closed shared seam (#594)** · no-signature-on-terminal
  project (#595).
- **Truth + speed:** home-KPI single-source · getMe SSR-hop removed · consent doc-id CTE · dev IPv4
  latency (the "site feels slow" = the localhost→IPv6 ~200ms dev tax; opt-in IPv4 bind shipped, your
  launcher patched; the **hosts-file `127.0.0.1 localhost` is the admin one-liner — owner-gated**).
- **Smart-managing spine:** ProjectPerception assembler (1.1) · signature-stalled/expiring
  recommenders (1.3) · catalog drift-guard (1.0).
- **Technophobe UX:** Tasks situation-picture · Documents board-primitives reuse · search/filter on
  lists · generate-apartments · נסח de-jargon · the doctrine anchors (final-bar + away-mode + latency-QA).

## ✅ Verified against the bar

- **FE technophobe audit — PASS across all 6 roles** (manager/agent/viewer/contractor/tenant/provider):
  situation-pictures at a glance, one-click legible actions, no jargon/schema leaks, no flat walls, <1s.
- **At-scale verification (100s of projects):** home-KPI == Σ per-project boards, autonomy producer
  correct + idempotent + PII-free, heavy reads 2–13ms warm, **zero cross-org leak**. One divergence
  found + fixed (#592).
- **Standing red-team — 4+ rounds, every confirmed finding fixed + independently red-team-closed:**
  email/cross-entity (41), at-scale numbers, auth/MFA/export-PII, import/messaging/FE-XSS/cache,
  sign/cert/ownership/bootstrap/governor-exactly-once, DTO/state-machine/cache-invalidation.

## ⏳ Your one-click actions on return (owner-gated — add `Gate-6-Approved:` trailer → merge)

| PR       | What                               | Note                                                                                                                                                                  |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#588** | wave-1.2 executor-extraction spine | migration 0083; auto-execute stays **OFF** (enabling a kind is a separate per-kind opt-in, gated behind the 1.5 undo-ledger). Red-team PASS, boundary non-bypassable. |
| **#591** | building-permit tracking           | migration 0083 (additive/reversible).                                                                                                                                 |
| **#592** | at-scale data-truth fix            | migration 0083 + **prod backfill of 41 legacy both-parent rows**.                                                                                                     |
| **#498** | sensitive-doc encryption           | your pre-existing Gate-6 + prod backfill.                                                                                                                             |
| **#512** | consent/opt-out registry           | the **unblocker for all real outbound** (reminders/reissues/chases are consent-fail-closed until this lands).                                                         |

**⚠️ #588 / #591 / #592 each carry a migration numbered `0083`** → on merge they collide; renumber to
0083/0084/0085 in merge order (rename the `.sql` + bump the `_journal.json` `when`).

## ⏭️ Skipped per your document-and-skip (owner-gated, not built)

- wave-4 cross-party **delivery** (needs #512 + real outbound to real recipients).
- future-states 2.5/2.6/2.7 (owner-competency / doc-legal-status / objections-financing — each a migration).
- enabling auto-execute in prod.
- tracked chip `task_34df6a51`: extend the terminal-project guard to the resend/reissue paths (minor;
  those re-deliveries are consent-blocked anyway post-#594).

## Run status

Never stopped, host never crashed (capped parallelism, freed disk). Continuing: a final red-team
confirmation round on current main, then calm monitoring + any non-gated polish, until you return.
