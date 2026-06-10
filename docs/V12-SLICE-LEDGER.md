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

### Status (live)

- Spec ✅ · Reproduce-RED ✅ (test-author: 3 RED on unfixed, 3 controls green) · Build ✅
  (typecheck 5/5=0, lint clean) · IndepTests ✅ (160 passed; 6 = phase5 E2E failing only
  at the local signup throttle http_429, CI-only; 11 skipped).
- CodeReview ✅ — logic PASS; the 24-spec blocker was RESEEDED with real ownership ties
  (gate NOT weakened) + 2 new tests (bulk-partial, scope-less); D.51 statement in PR #345.
- Security ✅ — authorization PASS (gate fires single+bulk pre-row/token, RLS-clean, no
  leak); Gate-6-Approved trailer in PR #345 (owner autonomous-merge authorization).
- BrowserQA ⚠️ HONEST — live server confirmed running the new code + migration 0063
  (CHECK has 'expired'); dedup enforced live (409 correct); the QA owner verified genuinely
  associated with the doc's project (consistent with the gate). The full positive+negative
  gate is proven by the 6 integration tests (same code path, real DB) + both reviews; a
  STANDALONE live-HTTP fresh-create/negative repro was blocked by QA-fixture friction
  (owner-create DTO + seed-encryption typing + wrong cancel route) — NOT a gate problem. A
  cleaner live UX repro lands with Phase-3 entity-model UI fixtures.
- CI ⏳ running (merged main: #343 M-2 + #344 S-1 came in; conflict on REVIEW doc resolved).
- Merge-on-green ⏳ · Critic ⏳ · Memory ⏳

Rule: any real-red → slice stays OPEN with the blocker named here; never force-merge.
