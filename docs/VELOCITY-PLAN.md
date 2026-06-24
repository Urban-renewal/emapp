# Accelerate without lowering the quality bar — examination

Owner 2026-06-23: "we lost precious time; find how to accelerate without hurting implementation quality."
This is the grounded diagnosis + the prioritized plan. **The thesis up front:** none of the lost time
came from the quality gates. It came from (1) environment collapse and (2) rework from shallow-first
passes. Both are pure waste. Removing them speeds us up AND raises quality — the gates are not where to cut.

## Where the time actually went (this documents-redesign stretch)

| Loss                              | ~weight | Root cause                                                                                                                                                                         | Gate-related?                                          |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Host machine crash + recovery** | LARGEST | disk → 100% (37+ orphan worktrees, each a pnpm install) + 38 orphan `node` procs → husky fork-crash, dev-server OOM, full crash + reboot                                           | **No** — pure environment waste                        |
| **Shallow "WALK PASSES" → redo**  | large   | declared pass without verifying the NUMBERS / outcome; owner caught it twice → full re-walk cycles                                                                                 | **No** — under-executing the gate, not the gate itself |
| **Rabbit holes**                  | medium  | Hebrew-in-shell encoding, hardcoded-slug test collisions, `/tmp` path mismatches, a sed-corrupted patch (lost S4-taxonomy), dev-login env-var (`DEV_AUTH_BYPASS` not in Infisical) | **No** — mechanical friction                           |
| **Per-PR overhead**               | medium  | S2 + S3 shipped as SEPARATE PRs though they're one cohesive FE wave sharing files → 2× CI (~4min each) + a rebase + 2 merge-watches                                                | **No** — process structure                             |
| dev→Neon RTT                      | small   | dev DB across the network (~165ms/query)                                                                                                                                           | No                                                     |

**Conclusion: the gates (deep walk, red-team, sub-second, CI green) cost us nothing we wouldn't have paid
anyway. The waste is environment fragility + not-deep-enough-first-time + serial process overhead.**

## The plan — ranked by leverage (each preserves quality)

### 1. Kill the environment-collapse class (reclaims the BIGGEST loss)

The crash was 100% preventable. Concrete, durable controls:

- **HARD CAP ≤3 concurrent builder worktrees.** The 37-worktree pileup is the root of the crash.
- **AUTO-PRUNE on completion** — every finished builder's worktree DIR is removed with PowerShell
  `Remove-Item -Recurse -Force` (not just `git worktree remove`, which leaves the pnpm read-only dir).
- **PRE-FLIGHT DISK GUARD** — refuse to spawn a builder when free disk < 15 GB; prune first. (`scripts/dev/preflight.sh`.)
- **PROCESS REAPER** — a script the OWNER runs (the agent may NOT mass-kill host procs — the classifier
  blocks it) to clear orphan dev/vitest/tsc node procs between sprints.
- **Default to `start-dev-local.ps1`** (local-pg) — never pay the dev→Neon RTT; sub-ms queries.
- _Quality impact: positive — a stable host is the precondition for running the gates at all._

### 2. Deep-walk FIRST, never after pushback (kills the rework class — HIGHEST leverage)

The shallow→redo cycles each cost a full iteration. The deep walk is ALREADY the standard (CLAUDE.md §G-QA);
the fix is EXECUTION. Make the **number cross-check a mandatory FIRST step**: query the BE/DB directly and
assert the rendered numbers match (exactly what finally worked here — board-completeness 13/13 + drilling
into רסקו to prove "0/4" was real). One deep pass is strictly faster than shallow-then-redo.

- _Quality impact: this IS the quality gate — done right-first-time it's also the fastest path._

### 3. Coarser PRs: one wave = one branch = one PR (kills per-PR overhead)

Already an anchored rule ("fewer coarser PRs"); under-applied here. A redesign wave is built in parallel
(capped worktrees) but **combined into ONE PR** → one CI run, one deep walk, one merge — not N.

- _Quality impact: neutral — gates stay per-change; it's one thorough pass over a cohesive whole._

### 4. Build parallel, verify serial (the structural accelerator)

Code-green parallelizes across agents/worktrees; the real-Chrome deep walk + red-team are inherently serial
and the lead's. So: **fan out builds → barrier → ONE combined deep walk + red-team**. For big multi-slice
efforts use the Workflow/ultracode harness to orchestrate the fan-out. Wall-clock shrinks via parallel
BUILD, never via skipped VERIFY.

### 5. Automate the mechanical friction (kills rabbit holes)

- **`pre-push` hook that runs `gen:api-docs`** — the #526 build failure was a stale generated doc; a local
  regen catches it before the ~4-min CI round-trip.
- **BE verification via DB-backed integration specs, not curl** — avoids the Hebrew-encoding + DTO-guessing
  holes. (The classifier 49/49 + board 13/13 specs were the fast, reliable proof; curl was the time-sink.)
- **Never `sed` a patch** (corrupts it); use `git diff ':(exclude)…'` pathspec. Branch builders off CURRENT main.

## Do-first (top 3, highest leverage / lowest cost)

1. **Environment controls** — `scripts/dev/preflight.sh` (disk + orphan-proc check) + a reaper + the ≤3-builder
   cap, anchored in CLAUDE.md. Prevents the single biggest loss from recurring.
2. **Deep-walk-first discipline** — already anchored; the lead executes the number-cross-check as step 1 of every walk.
3. **Coarser PRs + parallel-build/serial-verify** — apply the existing rule; orchestrate big waves via Workflow.
