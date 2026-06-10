# V12 — Slice execution ledger (self-control)

> Self-imposed control. A slice may NOT be marked merged until **every** gate
> below is ✅ with evidence. The manager re-reads this at the start of each slice.
> Gates: Spec · Reproduce(RED) · Build · IndepTests(GREEN) · CodeReview · Security
> · BrowserQA · CI · Merge-on-green · Critic · Memory.

## Slice 1 — signature correctness (#2 #3 #5) · branch feat/s1-signature-correctness

Scope (from docs/DESIGN-project-model-and-autosetup.md §5):

- **#2 assignment matrix** — recipient owner must have an `ownership` tying them to
  the document's scope (apartment-doc → that apartment; project-doc → any apartment
  in that project). Reject otherwise (`recipient_not_associated`). Single + bulk.
- **#3 expired-dedup** — the "pending exists" guard (single + bulk) must also require
  `expiresAt > now()`; add `expired` to the status CHECK + wire enum (migration 0063,
  `when` > 1782054000000) + backfill `pending`→`expired` where `expires_at <= now()`.
- **#5** — verify the signing page is reachable once #3 is fixed (browser QA).

| Gate               | Status | Evidence                                                                         |
| ------------------ | ------ | -------------------------------------------------------------------------------- |
| Spec               | ✅     | this section + §5 of the design doc                                              |
| Reproduce (RED)    | ⏳     | test-author: failing tests for #2 + #3                                           |
| Build              | ⏳     | builder: service + migration 0063 + wire enum                                    |
| Indep tests GREEN  | ⏳     | —                                                                                |
| Code-review (D.51) | ⏳     | —                                                                                |
| Security-review    | ⏳     | (assignment = authorization → MUST review)                                       |
| Browser QA         | ⏳     | send→associated=ok / non-associated=blocked / expired=resend / signing reachable |
| CI green           | ⏳     | —                                                                                |
| Merge-on-green     | ⏳     | autonomous, incl. migration                                                      |
| Critic             | ⏳     | —                                                                                |
| Memory             | ⏳     | —                                                                                |

Rule: any real-red → slice stays OPEN with the blocker named here; never force-merge.
