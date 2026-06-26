#!/usr/bin/env node
/**
 * Next.js dev launcher with an OPT-IN IPv4-only bind (PERF, 2026-06-26).
 *
 * Why this wrapper exists
 * -----------------------
 * `next dev` (Turbopack) binds `0.0.0.0` by default, which on Windows also opens
 * an IPv6 `[::]` loopback listener. The browser resolves `localhost:3001` to BOTH
 * `[::1]` (IPv6, tried FIRST) and `127.0.0.1` (IPv4). On hosts where the IPv6
 * loopback is degraded, the browser's first attempt stalls ~200ms+ before falling
 * back to IPv4 -> every click feels >1s (the "IPv6 localhost tax", PR #581).
 *
 * Setting `DEV_WEB_IPV4=1` makes us pass `--hostname 127.0.0.1`, so the `[::1]`
 * listener never exists; the browser's IPv6 attempt is abandoned fast (Chrome's
 * Happy-Eyeballs) and it uses `127.0.0.1` immediately -- no tax.
 *
 * Why it is OPT-IN (default stays 0.0.0.0)
 * ----------------------------------------
 * Binding IPv4-only is NOT free for every client: a *serial* client (Node's
 * `http.get`, curl's default) that tries `[::1]` first and then waits can pay a
 * 1-2s timeout against the now-refused IPv6 address on a flaky-IPv6 host. CI and
 * Playwright (`pnpm dev`, `webServer.url: http://localhost:3001`) use exactly such
 * serial probes, so the shared default MUST stay dual-stack `0.0.0.0`. The owner's
 * local browser flow opts in by exporting `DEV_WEB_IPV4=1` (start-dev-local.ps1).
 *
 * The DEFINITIVE host-wide fix is mapping `localhost` -> 127.0.0.1 in the Windows
 * hosts file (admin/owner-gated) -- see docs/LOCAL-DEV.md. This wrapper is the
 * reversible, no-admin stopgap for the browser, and keeps the single `pnpm dev`
 * (turbo) workflow + live API logs unchanged.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ipv4 = process.env.DEV_WEB_IPV4 === '1';
const nextArgs = ['dev', '--port', '3001', '--turbopack'];
if (ipv4) nextArgs.push('--hostname', '127.0.0.1');

// eslint-disable-next-line no-console
console.log(
  `[web:dev] binding ${ipv4 ? '127.0.0.1 (IPv4-only -- DEV_WEB_IPV4=1)' : '0.0.0.0 (dual-stack, default)'}`,
);

// Resolve Next's own CLI entry from this package's dependency tree (robust to PATH:
// works under turbo, pnpm, and a fresh worktree alike — no reliance on .bin on PATH).
const require = createRequire(import.meta.url);
const nextPkgJson = require.resolve('next/package.json');
const nextDir = path.dirname(nextPkgJson);
const nextBin = path.join(nextDir, 'dist', 'bin', 'next');

const proc = spawn(process.execPath, [nextBin, ...nextArgs], { stdio: 'inherit' });
proc.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
