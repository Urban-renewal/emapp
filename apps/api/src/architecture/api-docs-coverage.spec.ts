import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Architecture guard: API-docs COVERAGE (the gap the stale-check cannot see).
 *
 * `pnpm --filter @emapp/api gen:api-docs:check` only proves
 * docs/09-api-reference.generated.md == the script's output — it does NOT
 * prove the script's manual ENDPOINTS registry covers the actual controllers.
 * V12 shipped ~60 routes (portal, signature-requests, documents, roles,
 * discovery, member capabilities, …) that silently never reached the docs.
 *
 * This spec statically scans every `*.controller.ts` under src/ (same
 * static-scan posture as agent-capability-guard.spec.ts), builds the set of
 * `METHOD /api/v1/<prefix>/<path>` routes, and asserts each one has an entry
 * in scripts/gen-api-docs.ts ENDPOINTS. Param names are normalized (`:id` vs
 * `:userId` is not a difference). It FAILS when someone adds a controller
 * route without documenting it.
 *
 * NOTE: gen-api-docs.ts is read as TEXT (regex), not imported — importing it
 * would execute its top-level writeFileSync and rewrite the generated doc as
 * a test side-effect.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEN_SCRIPT = join(SRC_DIR, '..', 'scripts', 'gen-api-docs.ts');

/**
 * Routes DELIBERATELY absent from the API reference. Each needs a
 * justification — this is not a parking lot for "document later".
 */
const ALLOWLIST = new Set<string>([
  // Liveness probe — orchestrator-facing, no {data} envelope (exempt per
  // apps/api/CLAUDE.md), not part of the product API contract.
  'GET /api/v1/health',
  // Readiness probe — same posture as /health (DB-ping variant).
  'GET /api/v1/ready',
  // Prometheus scrape target (P0.B2) — network-restricted at the ingress
  // layer; text/plain gauge dump, not a product endpoint.
  'GET /api/v1/metrics',
]);

/**
 * ENDPOINTS entries allowed to have NO matching controller route YET.
 * Documented-ahead-of-merge only; remove the entry once the route lands.
 */
const DOC_AHEAD_ALLOWLIST = new Set<string>([]);

/** `:userId` / `:apartmentId` / `:id` are all just "a path param". */
function normalize(path: string): string {
  return path
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .replace(/:[A-Za-z0-9_]+/g, ':p');
}

function collectControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectControllerFiles(full));
    } else if (entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface DiscoveredRoute {
  key: string; // normalized "METHOD /api/v1/..."
  raw: string; // un-normalized, for readable failure output
  file: string;
}

/** Static scan: @Controller('prefix') + @Get/@Post/@Patch/@Put/@Delete('path'). */
function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const file of collectControllerFiles(SRC_DIR)) {
    const src = readFileSync(file, 'utf8');
    // Project style is uniform (`@Controller('x')` / `@Get(':id')`, no inner
    // whitespace) — verified by the sanity floor below. The detect-unsafe-regex
    // hits are FALSE POSITIVES: `(?:'([^']*)')?` is unambiguous (quote-delimited,
    // no overlapping quantifiers → linear time) and the input is our own
    // checked-in source files, not attacker-controlled.
    // eslint-disable-next-line security/detect-unsafe-regex
    const ctrl = /@Controller\((?:'([^']*)')?\)/.exec(src);
    if (!ctrl) continue; // not a Nest controller (defensive)
    const prefix = ctrl[1] ?? '';
    // eslint-disable-next-line security/detect-unsafe-regex
    const routeRe = /^[ \t]*@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)$/gm;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(src)) !== null) {
      const method = (m[1] as string).toUpperCase();
      const sub = m[2] ?? '';
      const path = `/api/v1/${[prefix, sub].filter(Boolean).join('/')}`;
      routes.push({
        key: `${method} ${normalize(path)}`,
        raw: `${method} ${path}`,
        file: file.slice(SRC_DIR.length + 1).replace(/\\/g, '/'),
      });
    }
  }
  return routes;
}

/** Extract the documented routes from gen-api-docs.ts ENDPOINTS (as text). */
function documentedRoutes(): Set<string> {
  const src = readFileSync(GEN_SCRIPT, 'utf8');
  const out = new Set<string>();
  const re = /method:\s*'([A-Z]+)'\s*,\s*path:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.add(`${m[1]} ${normalize(m[2] as string)}`);
  }
  return out;
}

describe('architecture: API-reference coverage (every controller route has an ENDPOINTS entry)', () => {
  const discovered = discoverRoutes();
  const documented = documentedRoutes();

  it('sanity: the controller scan found the known surface', () => {
    // If this collapses the scanner regressed (e.g. decorator regex broke)
    // and the real assertion below would pass vacuously.
    expect(discovered.length).toBeGreaterThanOrEqual(120);
    expect(documented.size).toBeGreaterThanOrEqual(120);
  });

  it('every controller route is documented in scripts/gen-api-docs.ts ENDPOINTS (or allowlisted)', () => {
    const missing = discovered.filter((r) => !documented.has(r.key) && !ALLOWLIST.has(r.key));
    expect(
      missing.map((r) => `${r.raw}  (${r.file})`),
      `Controller route(s) MISSING from the gen-api-docs ENDPOINTS registry.\n` +
        `docs/09-api-reference.generated.md cannot document what the registry\n` +
        `does not list — add an Endpoint entry (method/path/auth/summary/request/\n` +
        `response/errors) to apps/api/scripts/gen-api-docs.ts and re-run\n` +
        `\`pnpm --filter @emapp/api gen:api-docs\`. If the route is deliberately\n` +
        `undocumented (infra probe), add it to ALLOWLIST with a justification.\n\n` +
        missing.map((r) => `  - ${r.raw}`).join('\n'),
    ).toEqual([]);
  });

  it('no stale ENDPOINTS entry documents a route that no longer exists', () => {
    const discoveredKeys = new Set(discovered.map((r) => r.key));
    for (const k of ALLOWLIST) discoveredKeys.add(k); // infra routes live outside ENDPOINTS anyway
    const stale = [...documented].filter(
      (k) => !discoveredKeys.has(k) && !DOC_AHEAD_ALLOWLIST.has(k),
    );
    expect(
      stale,
      `ENDPOINTS entr${stale.length === 1 ? 'y' : 'ies'} with NO matching controller route —\n` +
        `either the route was removed/renamed (delete/fix the entry + regenerate)\n` +
        `or the entry's path has a typo (which would ALSO fail the coverage check\n` +
        `above for the real route):\n` +
        stale.map((k) => `  - ${k}`).join('\n'),
    ).toEqual([]);
  });
});
