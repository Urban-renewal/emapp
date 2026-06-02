# DV — ACTION-LEVEL findings (the real pass)

> The prior coverage runs (#231–234) verified that pages **render** — they did
> NOT perform actions. Owner feedback (2026-06-02): "most things didn't work
> when I tried to use them." This file holds findings from **performing the
> action and confirming the outcome** (or capturing the silent failure), with a
> manager-vs-role comparison so a claim is isolated, not guessed.
>
> **Standard:** "works" = the action was executed AND its outcome confirmed.
> Render ≠ works. Every prior "🟩 works" verdict is DOWNGRADED to
> "renders, function-unverified" until re-tested here.

## Findings

| ID               | Sev                     | Area             | Finding (action-level, isolated)                                                                                                                                                                                                                                                                                                                                                                  | Proof                                                           |
| ---------------- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **DV-AGENT-NAV** | **HIGH**                | agent / projects | **Agent cannot open its own assigned projects.** Clicking a project card navigates to the detail for **manager** (`navigated=true → /projects/{id}`) but is a **dead click for agent** (`navigated=false`, stays on `/projects`, 0 console errors). Agent sees its 2 assigned projects (ארלוזורוב 14, ויצמן 20) but can drill into none → effectively no data access. Matches the owner's report. | `dv-reality-compare.spec.ts`: manager nav=true, agent nav=false |
| DV-AGENT-CREATE  | MED (UX, like DV-ORG-9) | agent / projects | Agent sees a **"צור פרויקט" (create project)** control that does nothing on click (dead — stays on `/projects`). Likely an unauthorized control shown to a role that can't use it (same class as the viewer write-controls leak DV-ORG-9). Confirm BE 403 on the underlying create.                                                                                                               | `dv-reality-agent2.spec.ts`: createClick url unchanged          |

## Method (carry into the full re-verification)

For each interactive control, per role: **click/submit it, then confirm the outcome** — URL change, entity created (appears in list / DB), state changed, OR the exact failure (no-op / 4xx-5xx / console error). For role-gated behavior, run the SAME action as a role that SHOULD succeed (manager) and compare — that isolates a real bug from a bad selector.

## Still to re-verify at action level (owner-reported "didn't work")

- **Provider** — owner: "no button or tab worked, couldn't create anything." My prior run called it "cleanest" from RENDER only. MUST perform: onboard create, suspend/reactivate, tab navigation, every action → confirm works or capture failure.
- **Agent** — full: every nav tab actually loads its data; which controls are dead vs functional.
- **Viewer** — DV-ORG-9 write controls: confirm each 403s (UX dead-click) vs any that actually mutate (security).
- **Notifications** — owner flagged; verify they generate + render + mark-read works.
- **Manager** — re-verify creates/edits/archives actually persist (not just render the form).
