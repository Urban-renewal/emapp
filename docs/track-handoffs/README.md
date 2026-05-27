# Track Handoffs

> **Cross-agent coordination log.** Dated notes from one track's agent to
> another, discoverable at session start without needing live chat or
> session-handoff context.

## When to write a handoff here

You're Track X doing work that affects Track Y's workflow,
conventions, file ownership, or open PRs. Examples:

- You changed a shared convention (heartbeat format, branch naming,
  worktree layout)
- You opened a PR that introduces infra the other track must adopt
- You found a bug in the other track's PR that they should know about
  (vs. silently fixing or quiet-flagging)
- You killed a process / changed a port / changed seed data the
  other track might be depending on

What is NOT a handoff:

- A heartbeat entry — those go to `docs/heartbeats/track-<your-track>/`
- A PR description — those go in the PR itself
- An architectural decision — those go in `docs/DECISIONS.html`

## Naming

```
docs/track-handoffs/<receiving-track>-from-<sending-track>-YYYY-MM-DD.md
```

Examples:

- `track-a-from-track-b-2026-05-27.md` — Track B writing TO Track A
- `track-b-from-track-a-2026-05-28.md` — Track A's reply / next-day note

If multiple handoffs in one direction on the same day, append a suffix:

```
track-a-from-track-b-2026-05-27-2.md
```

## Content shape

Self-contained. The receiving agent reads this **cold** with zero
context — no shared session, no thread to scroll. Include:

1. **Why you're reading this** — one paragraph that says what changed
   and why the other track cares.
2. **Numbered items** — each one a concrete change with: what
   happened, why, what to do (if anything), what NOT to do.
3. **What's safe / what's not** — ownership reminder.
4. **Channel back** — invitation to reply via the symmetric file.

Match the writing style of the surrounding repo: opinionated,
direct, file paths, no marketing language.

## Lifecycle

Handoff files are **append-only history**. Never edit a past
handoff — even if the info became stale, leave it as the historical
record and write a new handoff that supersedes it. The chronology
(filename date) is the canonical order.

There's no "close" or "ack" mechanism. The receiving agent can
write a reply handoff in the other direction, but isn't required to
acknowledge — silence means "read and proceeding."

## Why not just use chat / Slack / GitHub Discussions?

Three reasons:

1. **Agents don't read chat history** — each session starts cold.
   File-based handoffs are part of the repo state every session
   loads automatically.
2. **Git-tracked** — the conversation is reviewable in PR diffs,
   searchable in history, and travels with the code.
3. **Survives session ends** — a chat message is lost if the
   receiving session never opens; a committed file is found.

The pattern was started 2026-05-27 by Track B after a session where
two agents lost ~20% of their time to coordination noise that would
have been a 3-line note here.
