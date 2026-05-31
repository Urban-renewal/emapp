import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { POLICY, type Action, type Resource } from '../common/authz/policy';

/**
 * D.54 fail-open guard (the "no ungated side-door" wall).
 *
 * D.46/D.54 coarsely loosened several POLICY write cells from manager-only to
 * manager+agent (buildings, apartments, owners, tasks, documents,
 * signature_requests, imports). Each loosening is SAFE ONLY because the matching
 * service method also runs the FINE gate — `requireAgentCapability(...)` (or its
 * non-throwing sibling `agentHasCapability(...)`, used where the capability is
 * one of several legitimate paths, e.g. tasks.update's narrow assignee path).
 * If a new agent-write endpoint is added to a loosened cell and forgets that
 * call, the coarse loosening becomes an UNGATED side door — an agent writes
 * without holding the capability. CLAUDE.md / D.54 require this to be mechanical,
 * not reviewer-judgment.
 *
 * This guard turns the per-cell "GUARDRAIL" comments in policy.ts into a wall.
 * For every controller endpoint whose (resource, action) cell coarsely admits
 * `agent` on a WRITE action (create/update/delete), it resolves the delegated
 * service method(s) and FAILS if none of them calls a capability gate. A small,
 * reviewed ALLOWLIST (in the spec) carries the deliberate exceptions whose
 * fine-scoping is NOT capability-based (notes = authorship; notifications =
 * RLS self-scope).
 *
 * Detection is source-text based (same posture as tenant-isolation.guard.ts):
 * controller class `@AuthzResource('<r>')`, per-handler HTTP verb / explicit
 * `@AuthzAction('<a>')`, and the `this.<svc>.<method>(` delegation, matched
 * against sibling `*.service.ts` method bodies.
 */

const WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>(['create', 'update', 'delete']);
const VERB_TO_ACTION: Record<string, Action> = {
  Post: 'create',
  Put: 'update',
  Patch: 'update',
  Delete: 'delete',
  Get: 'read',
};
const GATE_RE = /\b(?:requireAgentCapability|agentHasCapability)\s*\(/;
const AUTHZ_RESOURCE_RE = /@AuthzResource\(\s*['"](\w+)['"]\s*\)/;
const AUTHZ_ACTION_RE = /@AuthzAction\(\s*['"](\w+)['"]\s*\)/;
const HTTP_VERB_RE = /@(Get|Post|Put|Patch|Delete)\b/;

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

/** Extract `async <name>(...) { ... }` methods with their preceding decorators. */
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

/** Map of method name → whether ANY same-named method in the dir is gated. */
function serviceGateMap(moduleDir: string): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const f of walk(moduleDir, (n) => n.endsWith('.service.ts') && !n.endsWith('.spec.ts'))) {
    for (const meth of parseMethods(readFileSync(f, 'utf8'))) {
      const gated = GATE_RE.test(meth.body);
      map.set(meth.name, (map.get(meth.name) ?? false) || gated);
    }
  }
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
    const resMatch = AUTHZ_RESOURCE_RE.exec(src);
    if (!resMatch) continue; // no @AuthzResource → AuthorizationGuard fails closed at runtime
    const resource = resMatch[1] as Resource;
    if (!(resource in POLICY)) continue;
    const rel = relative(modulesDir, ctrl).split(sep).join('/');
    const gateMap = serviceGateMap(dirname(ctrl));

    for (const meth of parseMethods(src)) {
      const verbMatch = HTTP_VERB_RE.exec(meth.decorators);
      if (!verbMatch) continue; // not an HTTP route handler
      const override = AUTHZ_ACTION_RE.exec(meth.decorators);
      const action: Action = override
        ? (override[1] as Action)
        : (VERB_TO_ACTION[verbMatch[1] ?? ''] ?? 'read');
      if (!WRITE_ACTIONS.has(action)) continue;
      if (!POLICY[resource][action].includes('agent')) continue; // not loosened to agent

      const serviceMethods = [...meth.body.matchAll(/this\.\w+\.(\w+)\s*\(/g)].map(
        (x) => x[1] ?? '',
      );
      const gated = serviceMethods.some((sm) => gateMap.get(sm) === true);
      out.push({
        file: rel,
        handler: meth.name,
        resource,
        action,
        serviceMethods: [...new Set(serviceMethods)],
        gated,
        key: `${rel}#${meth.name}`,
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
