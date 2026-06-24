# Reap orphan dev/build node processes — OWNER runs this (the agent may NOT mass-kill
# host processes; the auto-mode classifier blocks it). Clears the leftover
# next/nest/vitest/tsc/turbo/worktree node procs that accumulate across parallel-builder
# sprints and cause the RAM/fork exhaustion that crashed the host
# (docs/VELOCITY-PLAN.md + memory project_machine_crash_disk_process_exhaustion).
#
# SAFE: spares the Claude Code harness + its MCP servers (anything whose command line
# matches claude / anthropic / mcp / cli.js). Dry-run by default; pass -Kill to act.
#
#   powershell -ExecutionPolicy Bypass -File scripts/dev/reap-orphans.ps1          # preview
#   powershell -ExecutionPolicy Bypass -File scripts/dev/reap-orphans.ps1 -Kill    # reap
param([switch]$Kill)

$spareRe = 'claude|anthropic|@anthropic|mcp|\\ccd|cli\.js'
$devRe   = 'next|nest|vitest|jest|tsc|turbo|esbuild|webpack|\.claude\\worktrees|pnpm.*(dev|build|test)'

$rows = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $c = $_.CommandLine
  [pscustomobject]@{
    PID = $_.ProcessId
    WS  = [math]::Round($_.WorkingSetSize / 1MB)
    Spare = ($c -and $c -match $spareRe)
    Dev   = ($c -and $c -match $devRe)
    Cmd = if ($c) { $c.Substring(0, [Math]::Min(90, $c.Length)) } else { '<null>' }
  }
}

$kill = $rows | Where-Object { $_.Dev -and -not $_.Spare }
$keep = $rows | Where-Object { -not ($_.Dev) -or $_.Spare }

"node total: $($rows.Count) | SPARE/keep: $($keep.Count) | dev-orphans to reap: $($kill.Count)"
"--- KEEP (harness/mcp/other) ---"; $keep | Select-Object PID, WS, Spare, Cmd | Format-Table -AutoSize -Wrap
"--- REAP (dev/build orphans) ---"; $kill | Select-Object PID, WS, Cmd | Format-Table -AutoSize -Wrap

if (-not $Kill) { "`nDRY-RUN. Re-run with -Kill to terminate the REAP list."; return }
foreach ($p in $kill) {
  try { Stop-Process -Id $p.PID -Force -ErrorAction Stop; "killed $($p.PID)" }
  catch { "failed $($p.PID): $($_.Exception.Message)" }
}
"reaped $($kill.Count) orphan node process(es)."
