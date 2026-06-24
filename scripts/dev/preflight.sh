#!/usr/bin/env bash
# Pre-flight guard — run BEFORE spawning parallel builder worktrees.
# Prevents the disk+process exhaustion that crashed the host (see docs/VELOCITY-PLAN.md
# + memory project_machine_crash_disk_process_exhaustion). Exits non-zero to BLOCK the
# sprint when the host is unsafe, so the lead prunes/reboots first instead of crashing.
#
# Usage:  bash scripts/dev/preflight.sh        # report + block if unsafe
#         MIN_DISK_GB=20 bash scripts/dev/preflight.sh
set -euo pipefail

MIN_DISK_GB="${MIN_DISK_GB:-15}"      # refuse to build under this much free disk
MAX_WORKTREES="${MAX_WORKTREES:-3}"   # hard cap on concurrent builder worktrees
MAX_NODE_PROCS="${MAX_NODE_PROCS:-22}" # orphan-node alarm (2 dev servers ~12; a pile-up is 30-40)

fail=0

# --- disk (C:) ---
free_gb=$(df -BG /c 2>/dev/null | awk 'NR==2{gsub("G","",$4); print $4}')
echo "disk free: ${free_gb}GB (min ${MIN_DISK_GB}GB)"
if [ "${free_gb:-0}" -lt "$MIN_DISK_GB" ]; then
  echo "  ✗ LOW DISK — prune worktrees (git worktree list; PowerShell Remove-Item) before building." >&2
  fail=1
fi

# --- worktree count ---
wt=$(git worktree list 2>/dev/null | grep -c 'worktrees/agent-' || true)
echo "builder worktrees: ${wt} (cap ${MAX_WORKTREES})"
if [ "${wt:-0}" -ge "$MAX_WORKTREES" ]; then
  echo "  ✗ TOO MANY WORKTREES — finish/prune existing builders before spawning more." >&2
  fail=1
fi

# --- orphan node processes (RAM/fork pressure) ---
nodes=$(powershell.exe -NoProfile -Command "(Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count" 2>/dev/null | tr -d '\r ' || echo 0)
echo "node processes: ${nodes} (alarm ≥ ${MAX_NODE_PROCS})"
if [ "${nodes:-0}" -ge "$MAX_NODE_PROCS" ]; then
  echo "  ✗ ORPHAN NODE PILE-UP — owner runs scripts/dev/reap-orphans.ps1 (agent may not mass-kill)." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "PRE-FLIGHT FAILED — host unsafe for a parallel build sprint. Resolve the ✗ items first." >&2
  exit 1
fi
echo "PRE-FLIGHT OK — safe to spawn up to $((MAX_WORKTREES - wt)) more builder(s)."
