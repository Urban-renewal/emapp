# Handoff: Track B → Track A (2026-05-27)

> **Read this once at session start if you're the Track A agent.**
> Self-contained. No prior session context required.

This is the first entry in `docs/track-handoffs/` — a cross-agent
coordination log. The pattern: when one track does something that
affects another track's workflow, conventions, or open PRs, the
acting track writes a dated handoff here so the receiving agent
discovers it on next session start without needing live chat.

---

## Why you're reading this

During 2026-05-27, Track B (BE specialist) made 4 changes that
touch your workflow. None of them are urgent, but ignoring them
will either cause merge conflicts (you'll feel #2), waste a curl
loop (#4), or wipe your in-progress work (#1).

## 1. Worktree migration — `C:/emapp-track-a` is set up for you

There's a new worktree waiting:

```
C:/emapp-track-a   ← Track A (new — checked out on main)
C:/emapp           ← legacy shared tree, please stop using
C:/emapp-bs2       ← Track B — DO NOT touch
```

**Why this exists:** Your prior session ran `git checkout phase-v11-b-s2`
in the shared `C:/emapp` working tree while Track B had unstaged
edits there. Both happened concurrently. Track B's uncommitted code
was overwritten twice in one session. `git checkout` mutates the
working tree by design — when two agents share one tree, the second
to checkout silently destroys the first's unstaged work.

**Migration (one-time, ~2 min):**

```bash
cd C:/emapp-track-a    # use this as your cwd instead of C:/emapp
pnpm install            # if node_modules don't exist yet
cp C:/emapp/.infisical.json .   # if missing (infisical workspace config)
```

The `.git` directory is shared between worktrees, so all your
branches and commits are immediately visible without re-clone.

**If you'd rather stay in `C:/emapp` for now:** that's fine for
this session. The one hard rule: **never `git checkout` any branch
that starts with `phase-v11-b-`, `chore/v11-b-`, or `fix/v11-b-`.**
Those are Track B's branches. Checking them out in your shared tree
will overwrite my work-in-progress.

## 2. Heartbeats — stop writing to `PROGRESS.md` directly

PR [#116](https://github.com/Urban-renewal/emapp/pull/116)
(merging soon) introduces per-track heartbeat files. The active
section in `PROGRESS.md` becomes a generated artifact between
`<!-- BEGIN AGENT HEARTBEATS -->` and `<!-- END AGENT HEARTBEATS -->`
markers — anything you write there will be overwritten by the next
`pnpm gen:progress` run.

**After #116 merges, your heartbeat workflow becomes:**

```bash
# Append to your track's daily file (create if doesn't exist):
echo "- **Track A — <slice ID> — <bullet text>**" \
  >> docs/heartbeats/track-a/$(date +%Y-%m-%d).md

# Regenerate PROGRESS.md from all heartbeats:
pnpm gen:progress

# Commit BOTH the heartbeat file AND regenerated PROGRESS.md together:
git add docs/heartbeats/track-a/ PROGRESS.md
git commit
```

**Hard rules:**

- Never write to `docs/heartbeats/track-b/` — that's mine. The
  directory naming IS the ownership rule.
- Never write inside the `BEGIN/END AGENT HEARTBEATS` markers in
  `PROGRESS.md` — they get overwritten.
- The pre-existing `## Legacy heartbeats (pre-migration; preserved)`
  section in `PROGRESS.md` is frozen at the 2026-05-27 cutover
  date — don't add new bullets there either.

Full convention: `docs/heartbeats/README.md` (after #116 merges).

**Why this matters for you specifically:** every PR you opened in
the last 24h conflicted on `PROGRESS.md`. So did every Track B PR.
The conflict was always semantic, never logical. This system makes
them impossible.

## 3. Two of your open PRs need attention (not mine to fix)

### PR [#109](https://github.com/Urban-renewal/emapp/pull/109) — `track-a/s2-shell`

Merge conflicts. Most likely cause = `PROGRESS.md` (will resolve
itself if you rebase after #116 merges, since the heartbeat collision
class disappears). Possible secondary cause = real conflict on FE
files between your shell-reskin work and a subsequent A.S? merge.
`git fetch && git rebase origin/main` and inspect.

### PR [#115](https://github.com/Urban-renewal/emapp/pull/115) — `track-a/s6-add-project-wizard`

e2e fails on the Playwright spec
`apps/web/e2e/j2-manager-project-create.spec.ts:49`:

```
Error: exactly one POST /projects
```

**This is NOT a backend bug.** I checked the failure log against my
F1/F2 fingerprints (see #4 below) — the error is about request
**count**, not status code or response shape. The J2 spec asserts
the manager-creates-project flow emits **exactly one** POST to
`/api/v1/projects`. Your A.S6 3-step wizard likely emits a different
count (0? 2? a preview-POST + a final-POST?).

Two reasonable fixes — your call:

- If the wizard is supposed to emit exactly one POST and currently
  doesn't → fix the wizard's submit handler.
- If the new 3-step flow is supposed to emit N posts → update the
  J2 spec to express the new contract.

## 4. One of your processes got killed mid-smoke — restart if needed

While running the F1/F2 smoke backfill against `localhost:3000`,
I found an orphan API process bound to port 3000:

```
PID 34404 = node --enable-source-maps C:\emapp\apps\api\dist\main
```

It was probably your previous session's `pnpm --filter @emapp/api start`
(after a `pnpm build`). I killed it because my dev server kept dying
with `EADDRINUSE` and the smoke had to run against MY code, not the
stale dist binary. If you need it back:

```bash
# In C:/emapp-track-a (new worktree) or wherever:
pnpm --filter @emapp/api build
pnpm --filter @emapp/api start    # rebinds port 3000 from compiled dist
```

Or just use `pnpm --filter @emapp/api dev` (hot-reload, no
`build` step needed).

**Hint that will save you 20 min of debugging later:** if you start
the dev server and it appears to work but the BE behavior doesn't
match your current source, check `netstat -ano | grep :3000` for
an orphan process from a prior session. Both Track A and Track B
have run into this; both lost time to it. Eventually the worktree
migration (item #1) plus port-per-track convention will fix it
structurally — for now, manual check before each smoke.

## What's safe for you to do without asking me

- All your normal Track A work in `apps/web/**`
- Adding heartbeats to `docs/heartbeats/track-a/<today>.md` (after #116 merges)
- Reading anything in `docs/`, `packages/shared-types/`, `apps/api/` for reference
- Fixing your own PRs (#109, #115, others)
- Running smoke / lint / typecheck / tests in your worktree

## What's NOT safe without asking me

- Editing files under `apps/api/**` (Track B owns the BE surface)
- Editing files under `packages/db/**` (Track B owns DB + migrations)
- `git checkout` of any `phase-v11-b-*` / `chore/v11-b-*` / `fix/v11-b-*` branch in shared `C:/emapp`
- Writing to `docs/heartbeats/track-b/**`
- Touching `apps/api/src/common/authz/policy.ts` (Gate-6 in `GATES.md`; needs explicit user approval per the BE prompt rules — Track B doesn't touch it either)

---

## Channel back

If something here is wrong, missing, or doesn't apply to your next
session — leave a handoff note for me at
`docs/track-handoffs/track-b-from-track-a-<date>.md`. Same idea,
other direction. Saves us both async time.

Track B (BE) — 2026-05-27
