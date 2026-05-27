# Agent Heartbeats

> **Per-agent append-only heartbeat files. Source of truth for `PROGRESS.md`.**

## Why this exists

Multiple agents (Track A FE, Track B BE, Track C, Track D, future) used to
all append to the top of `PROGRESS.md`. Every PR conflicted on those lines.
At one point ~20% of a Track B session was spent resolving PROGRESS merge
conflicts. The collision was **semantic**, not technical: one ordered list,
one file, every agent contending for the top slot.

The fix: **each agent writes to its own file, indexed by date.** `PROGRESS.md`
becomes a generated artifact (`pnpm gen:progress`) that concatenates all
heartbeats in the canonical order. No two agents ever touch the same file →
zero merge conflicts on heartbeats.

## Convention

```
docs/heartbeats/
  track-a/
    2026-05-27.md          ← Track A agent writes here
    2026-05-28.md
  track-b/
    2026-05-27.md          ← Track B agent writes here
    2026-05-28.md
```

- **Filename**: `YYYY-MM-DD.md`. One file per agent per day. Multiple entries
  in the same file are fine (multiple bullets) — agents append to their own
  daily file. Different days → different files.
- **Content**: standard heartbeat bullets (`- **Track X — …**`). The
  generator inserts a per-day, per-track header automatically; agents do not
  need to repeat the date in the bullet.
- **No cross-track writes**: a Track B agent NEVER writes to
  `docs/heartbeats/track-a/`. The naming convention IS the ownership rule.

## How `PROGRESS.md` gets updated

`scripts/gen-progress.ts` reads all heartbeats, sorts by date (newest first),
and replaces the block between
`<!-- BEGIN AGENT HEARTBEATS -->` and `<!-- END AGENT HEARTBEATS -->` in
`PROGRESS.md`. Anything outside the markers is preserved.

```bash
pnpm gen:progress         # update PROGRESS.md
pnpm gen:progress:check   # exit 1 if PROGRESS.md is out of date (CI use)
```

## Agent workflow (Track A / B / future)

1. Decide your heartbeat content as before.
2. Append it to `docs/heartbeats/track-<your-track>/<today>.md`.
   - If today's file doesn't exist, create it.
   - Just write the bullet(s) — no date header (the generator adds it).
3. Run `pnpm gen:progress` to update `PROGRESS.md`.
4. Include BOTH the new heartbeat file AND the regenerated `PROGRESS.md` in
   the same commit.

CI runs `pnpm gen:progress:check` on every PR; if the heartbeat files and
`PROGRESS.md` are out of sync, the PR fails. (Same posture as
`pnpm --filter @emapp/api gen:api-docs:check`.)

## Migration posture

This system starts with **zero migration** of existing `PROGRESS.md`
content. Everything that was there before stays in the "Legacy" section
verbatim. From here forward, all new heartbeats go to the per-agent files,
and the generated section at the top is the live view.
