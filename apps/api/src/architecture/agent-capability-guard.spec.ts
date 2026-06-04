import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Resource } from '../common/authz/policy';

import { findAgentWriteEndpoints } from './agent-capability-guard';

const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules');

/**
 * Endpoints on an agent-loosened WRITE cell whose fine-scoping is DELIBERATELY
 * not capability-based (so they legitimately do not call requireAgentCapability /
 * agentHasCapability). Each must stay justified:
 *   - notes.*  → D.17 AUTHORSHIP scoping (manager-or-author edits; viewer 403 at
 *     the coarse gate). No per-agent capability governs notes. Still detected by
 *     the slice-5a scanner because notes carries @RequirePermission('notes.*')
 *     and `notes.{create,update,archive}` are agent-write cells in POLICY.
 *
 * SLICE 5a NOTE — notifications.markRead / markAllRead are NO LONGER in this
 * allowlist. The cutover marks them `@TenantScoped()` (a NO_ENGINE_EQUIVALENT
 * self/RLS surface — the catalog has no `notifications.*` permission), so the
 * scanner no longer classifies them as permission-gated agent-write endpoints at
 * all. They are not "an agent write missing a capability gate"; they are
 * authorized by tenant membership + RLS self-scope, which the guard enforces
 * directly. Keeping them here would now be STALE (the scanner does not detect
 * them), which the "no stale entries" test rightly rejects.
 *
 * Adding an entry here is a deliberate, reviewed decision (CODEOWNERS routes
 * apps/api to the owner) — it asserts "this agent-write endpoint is gated by
 * something OTHER than a capability, and that is correct".
 */
const ALLOWLIST = new Set<string>([
  'notes/notes.controller.ts#create',
  'notes/notes.controller.ts#update',
  'notes/notes.controller.ts#archive',
]);

describe('architecture: D.54 fail-open guard (every agent-loosened write endpoint gates the capability)', () => {
  const endpoints = findAgentWriteEndpoints(MODULES_DIR);

  it('detects agent-loosened write endpoints (sanity: the scan found the known surface)', () => {
    // If this drops to ~0 the scanner is broken (e.g. parsing regressed) and
    // would vacuously pass the real assertion below.
    expect(endpoints.length).toBeGreaterThanOrEqual(15);
  });

  it('no agent-loosened write endpoint is UNGATED (fail-open side door)', () => {
    const ungated = endpoints.filter((e) => !e.gated && !ALLOWLIST.has(e.key));
    expect(
      ungated.map(
        (e) => `${e.key}  (${e.resource}.${e.action} → this.x.{${e.serviceMethods.join(',')}})`,
      ),
      `Agent-loosened WRITE endpoint(s) with NO capability gate detected.\n` +
        `POLICY admits 'agent' on this (resource, action), but the delegated service\n` +
        `method does not call requireAgentCapability / agentHasCapability — the coarse\n` +
        `loosening is an UNGATED side door (an agent writes without the capability).\n\n` +
        ungated.map((e) => `  - ${e.key}  [${e.resource}.${e.action}]`).join('\n') +
        `\n\nFix: call requireAgentCapability(tx, user, '<capability>') in the service\n` +
        `method (after the record-scope check). If the endpoint is intentionally scoped\n` +
        `by something other than a capability (authorship, RLS self-scope), add its key\n` +
        `to ALLOWLIST with a justification.`,
    ).toEqual([]);
  });

  it('every capability-gated resource has a detected GATED write endpoint (gate-detection works)', () => {
    // Positive pin: proves the scanner actually RECOGNISES capability gates (so
    // "no ungated" can't pass vacuously by mis-reading every gate as present).
    // Each of these resources was loosened to agents in D.46 and MUST gate.
    const MUST_GATE: Resource[] = [
      'buildings',
      'apartments',
      'owners',
      'tasks',
      'documents',
      'signature_requests',
      'imports',
    ];
    const gatedResources = new Set(endpoints.filter((e) => e.gated).map((e) => e.resource));
    const missing = MUST_GATE.filter((r) => !gatedResources.has(r));
    expect(
      missing,
      `These D.46 capability-gated resources have NO detected gated write endpoint —\n` +
        `either the gate was removed (a real fail-open regression) or the scanner's\n` +
        `gate detection broke:\n` +
        missing.map((r) => `  - ${r}`).join('\n'),
    ).toEqual([]);
  });

  it('allowlist has no stale entries (re-gated/removed endpoints must leave it)', () => {
    const keys = new Set(endpoints.map((e) => e.key));
    const stale = [...ALLOWLIST].filter((k) => !keys.has(k)).sort();
    expect(
      stale,
      `These ALLOWLIST keys no longer match a detected agent-write endpoint.\n` +
        `Remove them to keep the ratchet honest:\n` +
        stale.map((k) => `  - ${k}`).join('\n'),
    ).toEqual([]);
  });
});
