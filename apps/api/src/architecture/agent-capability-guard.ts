import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { POLICY, type Action, type Resource } from '../common/authz/policy';
import { LEGACY_TO_PERMISSION } from '../common/authz/policy-equivalence.map';

/**
 * D.54 fail-open guard (the "no ungated side-door" wall).
 *
 * SLICE 5a — RE-POINTED to the engine model. The cutover removed the legacy
 * class-level `@AuthzResource` + verb/`@AuthzAction` declarations; every handler
 * now carries `@RequirePermission('<permission>')` (or `@TenantScoped()` for the
 * NO_ENGINE_EQUIVALENT self/RLS surfaces). The wall's PURPOSE is unchanged: it
 * still asserts that every endpoint admitting an AGENT on a WRITE cell also runs
 * the FINE capability gate in the service. It now resolves the cell from the
 * permission (reverse of the slice-3 `LEGACY_TO_PERMISSION` map) instead of from
 * the controller's class resource + the handler verb.
 *
 * Why the cell mapping is still `policy.ts`-shaped: the agent-loosening
 * GUARDRAILs (D.46/D.54) are expressed per `(resource, action)` cell, and the
 * capability that gates each is a property of that cell. The slice-3 map is the
 * faithful, test-pinned translation between the two vocabularies, so reversing
 * it gives the SAME set of agent-write endpoints the legacy scanner found — no
 * coverage is lost in the cutover. `policy.ts` stays in the tree until slice 6;
 * the `POLICY[resource][action].includes('agent')` test below is the same
 * coarse-loosening predicate, now reached via the permission.
 *
 * Each loosening is SAFE ONLY because the matching service method also runs the
 * FINE gate — `requireAgentCapability(...)` (or its non-throwing sibling
 * `agentHasCapability(...)`, used where the capability is one of several
 * legitimate paths, e.g. tasks.update's narrow assignee path). If a new
 * agent-write endpoint forgets that call, the coarse loosening becomes an
 * UNGATED side door. A small, reviewed ALLOWLIST (in the spec) carries the
 * deliberate exceptions whose fine-scoping is NOT capability-based (notes =
 * authorship; notifications = RLS self-scope).
 *
 * Detection is source-text based (same posture as tenant-isolation.guard.ts):
 * per-handler `@RequirePermission('<permission>')`, the HTTP verb, and the
 * `this.<svc>.<method>(` delegation, matched against sibling `*.service.ts`
 * method bodies.
 */

const WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>(['create', 'update', 'delete']);
const GATE_RE = /\b(?:requireAgentCapability|agentHasCapability)\s*\(/;
const REQUIRE_PERMISSION_RE = /@RequirePermission\(\s*['"]([\w.]+)['"]\s*\)/;
const HTTP_VERB_RE = /@(Get|Post|Put|Patch|Delete)\b/;

/**
 * Reverse the slice-3 `LEGACY_TO_PERMISSION` map: permission → the legacy
 * `(resource, action)` cell(s) it gates. One permission may back SEVERAL legacy
 * cells (e.g. `ownerships.set` ← create/update/delete; `imports.map` ←
 * start+mapping). We keep ALL cells: an endpoint is an "agent write" iff ANY of
 * its backing cells coarsely admits an agent on a write action — the safe
 * (widest) reading for a fail-open wall.
 */
const PERMISSION_TO_CELLS: ReadonlyMap<
  string,
  ReadonlyArray<{ resource: Resource; action: Action }>
> = (() => {
  const m = new Map<string, Array<{ resource: Resource; action: Action }>>();
  for (const [cellKey, permission] of Object.entries(LEGACY_TO_PERMISSION)) {
    if (!permission) continue;
    const dot = cellKey.lastIndexOf('.');
    const resource = cellKey.slice(0, dot) as Resource;
    const action = cellKey.slice(dot + 1) as Action;
    const arr = m.get(permission) ?? [];
    arr.push({ resource, action });
    m.set(permission, arr);
  }
  return m;
})();

/**
 * Does this `@RequirePermission('<permission>')` back an agent-loosened WRITE
 * cell? True iff any backing legacy cell is a write action AND coarsely admits
 * an agent in `POLICY`. Returns the representative (resource, action) for
 * reporting (the first matching agent-write cell), or null if none.
 */
function agentWriteCellFor(permission: string): { resource: Resource; action: Action } | null {
  const cells = PERMISSION_TO_CELLS.get(permission);
  if (!cells) return null;
  for (const cell of cells) {
    if (WRITE_ACTIONS.has(cell.action) && POLICY[cell.resource][cell.action].includes('agent')) {
      return cell;
    }
  }
  return null;
}

export interface AgentWriteEndpoint {
  /** module-relative controller path, e.g. `owners/owners.controller.ts` */
  file: string;
  /** handler method name, e.g. `update` */
  handler: string;
  resource: Resource;
  action: Action;
  /** delegated `this.x.<method>` names found in the handler body */
  serviceMethods: string[];
  /** true iff at least one delegated service method calls a capability gate */
  gated: boolean;
  /** stable allowlist key */
  key: string;
}

interface ParsedMethod {
  name: string;
  decorators: string;
  body: string;
}

/** Walk a dir, return absolute paths of files passing `pred`. */
function walk(dir: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, pred));
    else if (pred(entry.name)) out.push(p);
  }
  return out;
}

/** From `{` at `open`, return the substring through the matching `}`. */
function braceMatch(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** Contiguous decorator lines immediately above the method signature. */
function trailingDecorators(before: string): string {
  const lines = before.split('\n');
  const picked: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim();
    if (t === '') {
      if (picked.length === 0) continue; // skip the empty current-line tail
      break;
    }
    if (t.startsWith('@') || t.startsWith(')')) picked.push(lines[i] ?? '');
    else break;
  }
  return picked.reverse().join('\n');
}

/**
 * Extract `async <name>(...) { ... }` methods with their preceding decorators.
 * ASSUMPTION: every route handler and every mutating service method in this
 * codebase is `async` (they all `await withTenant(...)`). A non-`async` write
 * handler would be invisible to the scan — acceptable under the current
 * convention, called out so a future reviewer can broaden the regex if it changes.
 */
function parseMethods(src: string): ParsedMethod[] {
  const out: ParsedMethod[] = [];
  const re = /(?:\n|^)[ \t]*(?:public |private |protected )?async (\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] ?? '';
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const decorators = trailingDecorators(src.slice(0, lineStart));
    const brace = src.indexOf('{', re.lastIndex);
    if (brace === -1) continue;
    out.push({ name, decorators, body: braceMatch(src, brace) });
  }
  return out;
}

/**
 * Map of service method name → confident gate status, for the services in one
 * module dir. The delegated `this.<prop>.<method>` is resolved by NAME (the
 * scanner doesn't do full DI resolution), so a name that appears BOTH gated and
 * ungated across sibling services is AMBIGUOUS — and is reported as `false`
 * (NOT gated) on purpose: a fail-open guard must fail SAFE (flag for a human)
 * rather than trust an OR that could mask the ungated delegate. A name seen only
 * gated → `true`; only ungated → `false`. (No ambiguous collision exists in any
 * module today; this just keeps it sound under future drift.)
 */
function serviceGateMap(moduleDir: string): Map<string, boolean> {
  const seen = new Map<string, { gated: boolean; ungated: boolean }>();
  for (const f of walk(moduleDir, (n) => n.endsWith('.service.ts') && !n.endsWith('.spec.ts'))) {
    for (const meth of parseMethods(readFileSync(f, 'utf8'))) {
      const e = seen.get(meth.name) ?? { gated: false, ungated: false };
      if (GATE_RE.test(meth.body)) e.gated = true;
      else e.ungated = true;
      seen.set(meth.name, e);
    }
  }
  const map = new Map<string, boolean>();
  for (const [name, e] of seen) map.set(name, e.gated && !e.ungated);
  return map;
}

/**
 * Scan all controllers and return every agent-loosened WRITE endpoint, each
 * tagged with whether its delegated service method(s) call a capability gate.
 * The spec asserts that every `gated === false` row is in the reviewed allowlist.
 */
export function findAgentWriteEndpoints(modulesDir: string): AgentWriteEndpoint[] {
  const out: AgentWriteEndpoint[] = [];
  for (const ctrl of walk(modulesDir, (n) => n.endsWith('.controller.ts'))) {
    const src = readFileSync(ctrl, 'utf8');
    // Slice-5a: a controller with no @RequirePermission at all is not an
    // engine-gated domain controller (e.g. the contractor portal, which is
    // outside the org AuthorizationGuard). Skip cheaply.
    if (!REQUIRE_PERMISSION_RE.test(src)) continue;
    const rel = relative(modulesDir, ctrl).split(sep).join('/');
    const gateMap = serviceGateMap(dirname(ctrl));

    for (const meth of parseMethods(src)) {
      if (!HTTP_VERB_RE.test(meth.decorators)) continue; // not an HTTP route handler
      const permMatch = REQUIRE_PERMISSION_RE.exec(meth.decorators);
      if (!permMatch) continue; // @TenantScoped or unmapped → not a permission-gated write cell
      const cell = agentWriteCellFor(permMatch[1] ?? '');
      if (!cell) continue; // permission does not back an agent-loosened WRITE cell

      const serviceMethods = [...meth.body.matchAll(/this\.\w+\.(\w+)\s*\(/g)].map(
        (x) => x[1] ?? '',
      );
      const gated = serviceMethods.some((sm) => gateMap.get(sm) === true);
      out.push({
        file: rel,
        handler: meth.name,
        resource: cell.resource,
        action: cell.action,
        serviceMethods: [...new Set(serviceMethods)],
        gated,
        key: `${rel}#${meth.name}`,
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
