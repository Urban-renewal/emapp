# Merge Queue Setup Runbook — `main`

> **Status: PREPARED, NOT ENABLED.** Enabling the merge queue is a repository-settings
> change and therefore **the owner's action**. This runbook is one-click-ready: the
> only code change it requires (`merge_group:` trigger in `.github/workflows/ci.yml`)
> is **already merged/staged**. Everything below is the owner's UI/CLI step to flip
> the queue on.

Repo: `Urban-renewal/emapp` · Target branch: `main`

---

## Why a merge queue (the problem it kills)

Two PRs can each go green against an **older** `main`, then both merge and break the
tip — a missing workspace symlink, a migration-number desync, two migrations both
numbered `0077`, etc. ("stale-main" class). Today's serial manual merge does not
re-test against the live tip, so the second merge is effectively untested.

A merge queue, for **every** PR you queue:

1. Takes `main`'s **live tip** + the PR (and optionally batches several PRs),
2. Creates a temporary `gh-readonly-queue/main/...` ref,
3. Re-runs the **required checks** against that rebased ref (the `merge_group` event),
4. **Auto-merges** on green — or ejects the PR and keeps the rest moving on red.

This eliminates the stale-main class **and** the manual serial-merge bottleneck
**without lowering any gate** — the same required checks still must pass, just against
the real tip.

---

## Prerequisite (DONE — no action needed)

GitHub dispatches the queued batch via the **`merge_group`** workflow event. CI must
trigger on it, or the queue would wait forever for checks that never report.

- `.github/workflows/ci.yml` `on:` now includes `merge_group:` **additively** —
  `push` and `pull_request` are unchanged.
- Until the queue is enabled, `merge_group` events never fire, so this is a **pure
  no-op**. (That is why it was safe to land ahead of enabling.)
- All 9 CI jobs (`setup`, `typecheck`, `lint`, `test`, `build`, `conformance`, `e2e`,
  `secrets-scan`, `audit`) have **no** job-level `if:` gating on `github.event_name`,
  so every one of them runs on `merge_group` exactly as it does on `pull_request`.
  No required check can silently skip in the queue.

---

## Required checks to register with the queue

These are the status checks the queue must wait for (same set already required on PR
merge). They map 1:1 to CI job names plus the externally-configured CodeQL check:

| Check name (as GitHub reports it) | Source                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `setup`                           | `ci.yml` job                                                                                                               |
| `build`                           | `ci.yml` job                                                                                                               |
| `test`                            | `ci.yml` job                                                                                                               |
| `typecheck`                       | `ci.yml` job                                                                                                               |
| `lint`                            | `ci.yml` job                                                                                                               |
| `e2e`                             | `ci.yml` job                                                                                                               |
| `conformance`                     | `ci.yml` job                                                                                                               |
| `audit`                           | `ci.yml` job                                                                                                               |
| `secrets-scan`                    | `ci.yml` job                                                                                                               |
| `Analyze (...)` / CodeQL          | GitHub **default** code-scanning setup (configured in repo Settings → Code security, **not** a workflow file in this repo) |

> **Register exactly the checks already required on `main` today.** Do not add or
> rename any — this runbook does not change the required-check set. Confirm the live
> list before flipping the queue:
>
> ```bash
> # Classic branch protection:
> gh api repos/Urban-renewal/emapp/branches/main/protection/required_status_checks \
>   --jq '.checks[].context'
>
> # If main is governed by a ruleset instead, list rulesets and read the
> # required_status_checks rule:
> gh api repos/Urban-renewal/emapp/rulesets --jq '.[] | {id, name, target, enforcement}'
> gh api repos/Urban-renewal/emapp/rulesets/<RULESET_ID> \
>   --jq '.rules[] | select(.type=="required_status_checks")'
> ```
>
> The CodeQL check's **exact** context string (e.g. `Analyze (javascript-typescript)`)
> must match what code scanning reports — copy it verbatim from the command output, do
> not hand-type it.

---

## Recommended settings

| Setting                                                                    | Recommended    | Why                                                                                                                 |
| -------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Merge method                                                               | **Squash**     | Matches the current flow (history is squash-per-PR).                                                                |
| Build concurrency (max queued PRs tested in parallel)                      | **5**          | Enough to keep the pipeline full for a 2-dev team without burning Actions minutes.                                  |
| Minimum group size                                                         | **1**          | Don't wait to batch — merge a lone green PR immediately.                                                            |
| Maximum group size                                                         | **3**          | Batch up to 3 so a burst merges in one CI pass; small enough that one bad PR ejecting doesn't re-test a huge batch. |
| Maximum wait time to build a group                                         | **5 minutes**  | Cap how long the queue waits to fill a batch before testing what it has.                                            |
| Only merge non-failing pull requests ("Require all queue entries to pass") | **On**         | A PR that fails against the rebased tip is **ejected**, never merged — this is the whole point.                     |
| Status check timeout                                                       | **60 minutes** | Comfortably above the longest CI job; below it, a slow runner would wrongly eject.                                  |

> Group-size/concurrency numbers are tuning, not correctness — start here and adjust
> if Actions minutes or queue latency become an issue.

---

## Enable it — UI path (recommended)

1. **Settings → Rules → Rulesets** (or **Settings → Branches** if `main` still uses
   classic branch protection).
2. Open the ruleset / protection rule that targets `main`.
3. Enable **"Require merge queue"**.
4. Click **its settings** and set:
   - Merge method: **Squash**
   - Maximum / minimum group size: **3 / 1**
   - Maximum PRs to build (concurrency): **5**
   - Wait time to build a group: **5 min**
   - **Only merge non-failing pull requests**: **on**
   - Status check timeout: **60 min**
5. Confirm **Require status checks to pass** lists the checks in the table above
   (it already should — do not change the set).
6. **Save**.

That's the entire enable. PRs now get a **"Merge when ready"** button instead of
"Merge"; clicking it queues them.

---

## Enable it — `gh api` / REST path (equivalent)

> Prefer the UI. This is the scriptable equivalent for an audit trail. Run from an
> account with admin on the repo. **This is the owner's action.**

### A) If `main` uses a **ruleset** (modern)

1. Find the ruleset id governing `main`:
   ```bash
   gh api repos/Urban-renewal/emapp/rulesets --jq '.[] | {id, name, target}'
   ```
2. Read it, add a `merge_queue` rule (keep every existing rule intact), and PUT it back.
   The `merge_queue` rule parameters:
   ```json
   {
     "type": "merge_queue",
     "parameters": {
       "merge_method": "SQUASH",
       "grouping_strategy": "ALLGREEN",
       "max_entries_to_build": 5,
       "min_entries_to_merge": 1,
       "max_entries_to_merge": 3,
       "min_entries_to_merge_wait_minutes": 5,
       "check_response_timeout_minutes": 60
     }
   }
   ```
   ```bash
   # Pull current ruleset, append the merge_queue rule, push it back.
   gh api repos/Urban-renewal/emapp/rulesets/<RULESET_ID> > /tmp/ruleset.json
   # edit /tmp/ruleset.json: add the merge_queue object to .rules[]
   gh api -X PUT repos/Urban-renewal/emapp/rulesets/<RULESET_ID> \
     --input /tmp/ruleset.json
   ```
   > `grouping_strategy: ALLGREEN` is the "only merge non-failing PRs" behavior — a
   > failing entry is ejected and the rest re-tested.

### B) If `main` uses **classic branch protection**

GitHub's classic branch-protection REST schema does not expose a first-class
merge-queue toggle in a stable, documented field. **Use the UI path** to enable the
queue (UI writes the queue config), then verify via:

```bash
gh api repos/Urban-renewal/emapp/branches/main/protection --jq '.required_status_checks'
```

Do **not** rewrite `required_status_checks` here — only the queue toggle is being
added, and the check set must stay exactly as-is.

> Consider migrating classic branch protection to a ruleset (path A) at the same time,
> since rulesets give a clean, scriptable merge-queue config. That migration is a
> separate decision — out of scope for this runbook.

---

## How to verify it works

1. Open or pick a small, green PR.
2. The merge button now reads **"Merge when ready"** — click it. The PR enters the
   queue.
3. In the **Actions** tab a new CI run appears triggered by **`merge_group`**, running
   against a `gh-readonly-queue/main/<...>` ref. Confirm all required checks
   (`setup`, `build`, `test`, `typecheck`, `lint`, `e2e`, `conformance`, `audit`,
   `secrets-scan`, CodeQL) are present and running — **none skipped**.
4. On green, the PR **auto-merges** (squash) with no further click.
5. Negative check (optional but recommended): queue a PR that you know conflicts with
   or breaks against the current tip; confirm the queue **ejects** it (status comment
   on the PR) and does **not** merge it.

Watch the queued run live:

```bash
gh run list --event merge_group --limit 5
gh run watch <RUN_ID>
```

---

## How to disable / roll back

- **Disable the queue (keep CI as-is):** Settings → Rules/Branches → the `main` rule →
  turn **"Require merge queue"** off (or, ruleset path: remove the `merge_queue` rule
  and PUT the ruleset back). PRs revert to the normal **Merge** button immediately.
  No CI change needed — the `merge_group:` trigger goes dormant (events stop firing).
- **Full rollback** (only if you also want to remove the trigger): revert the
  `merge_group:` addition in `.github/workflows/ci.yml`. Not required — leaving it is
  harmless when the queue is off.

---

## Notes / caveats

- **Enabling is the owner's action.** This runbook performs nothing irreversible; it
  prepares the one CI change (already landed) and documents the exact toggle.
- The required-check **set, names, branch protection, CODEOWNERS, and auto-merge** are
  **not** modified by enabling the queue — the queue reuses the existing required
  checks against the rebased tip.
- The CodeQL/`Analyze` check comes from GitHub **default code-scanning setup** (repo
  Settings → Code security), not from a workflow file in this repo — that's why there
  is no `codeql.yml` to add `merge_group` to. Default-setup scans **do** run on the
  `merge_group` event automatically, so no workflow edit is needed for it.
- The exact `merge_queue` REST parameter names can drift with GitHub API versions;
  if `gh api` rejects a field, configure via the UI (authoritative) and treat the
  REST block as reference.
