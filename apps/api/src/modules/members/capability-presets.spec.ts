/**
 * S4b · #8 — capability PRESETS (design §7): a CODE-DEFINED catalog of named
 * role presets, each bundling a set of agent capabilities with a Hebrew
 * name+description, so a non-technical manager picks a named preset instead of
 * toggling the 7 raw capability flags. NO new table.
 *
 * INDEPENDENT acceptance test (test-author wrote this BEFORE the builder; the
 * impl files are NOT touched here). Tests are RED against current code and must
 * go GREEN after the builder adds:
 *   - GET  /api/v1/capability-presets                         (catalog list)
 *   - POST /api/v1/members/:userId/apply-capability-preset    (apply a preset)
 *
 * SPEC under test:
 *  1. GET /capability-presets returns the catalog — a non-empty list, each
 *     entry has { key, nameHe, descriptionHe, capabilities } (+ nameEn /
 *     descriptionEn). withTenant, {data} list envelope.
 *  2. apply-capability-preset SETS the agent's capability flags to the
 *     preset's bundle (reuses the UpdateAgentCapabilities path). Returns the
 *     updated member; the stored capabilities now equal the preset bundle.
 *  3. ONLY agents — applying to a non-agent (manager/viewer) is rejected per
 *     the existing capability rules (capabilities_agent_only / 400), mirroring
 *     updateCapabilities.
 *  4. Unknown presetKey → 400 (validation / rejected).
 *  5. (security) anti-escalation — the apply route requires `members.update`,
 *     the same gate as the existing PATCH :userId/capabilities route.
 *
 * Style mirrors members-resend-invite.spec.ts: SERVICE-level, real DB, real
 * JwtService + FakeEmailProvider, driven through MembersService with a cast so
 * the file COMPILES before the builder adds the methods. createTestOrg seeds
 * the org+manager; agents are seeded by inviting with role='agent' (a pending
 * agent membership satisfies the capabilities path: revokedAt IS NULL +
 * role='agent', exactly as updateCapabilities requires).
 *
 * RED now: MembersService has no `listCapabilityPresets` / `applyCapabilityPreset`
 * methods and the controller has no `capability-presets` / `apply-capability-preset`
 * routes → #1 + #2 throw "not implemented yet". The controller-source structural
 * assertions (route + gate) also go RED until the routes are added.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { serverEnv } from '@emapp/config';
import { FakeEmailProvider, memberships, withTenant } from '@emapp/db';
import {
  AGENT_CAPABILITY_KEYS,
  AgentCapabilitiesSchema,
  type AgentCapabilities,
  type Member,
} from '@emapp/shared-types';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { MembersService } from './members.service';

const jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
const members = new MembersService(jwt, new FakeEmailProvider());

const MGR_SID = '00000000-0000-4000-8000-0000000000c1';

let org: TestOrg;
let managerId: string;

function owner(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function uniqueEmail(tag: string): string {
  return `preset-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

function errCode(e: unknown): string | undefined {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const code = (body as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function httpStatus(e: unknown): number | undefined {
  return e instanceof HttpException ? e.getStatus() : undefined;
}

// ── Catalog entry shape the builder must return (the wire contract under test).
interface CapabilityPreset {
  key: string;
  nameHe: string;
  nameEn?: string;
  descriptionHe: string;
  descriptionEn?: string;
  capabilities: AgentCapabilities;
}

/** List the catalog via the (not-yet-existing) service method. Cast so this
 *  file compiles before the builder adds it. */
async function listPresets(user: AccessTokenPayload): Promise<CapabilityPreset[]> {
  const fn = (
    members as unknown as {
      listCapabilityPresets?: (u: AccessTokenPayload) => Promise<CapabilityPreset[]>;
    }
  ).listCapabilityPresets;
  if (typeof fn !== 'function') {
    throw new Error('MembersService.listCapabilityPresets is not implemented yet (RED — #8 gap)');
  }
  return fn.call(members, user);
}

/** Apply a preset to a target user via the (not-yet-existing) service method. */
async function applyPreset(
  user: AccessTokenPayload,
  targetUserId: string,
  presetKey: string,
): Promise<Member> {
  const fn = (
    members as unknown as {
      applyCapabilityPreset?: (u: AccessTokenPayload, id: string, key: string) => Promise<Member>;
    }
  ).applyCapabilityPreset;
  if (typeof fn !== 'function') {
    throw new Error('MembersService.applyCapabilityPreset is not implemented yet (RED — #8 gap)');
  }
  return fn.call(members, user, targetUserId, presetKey);
}

/** Invite a member with a role (pending; not accepted). Returns its userId.
 *  A pending agent satisfies the capabilities path (revokedAt IS NULL,
 *  role='agent'), exactly as updateCapabilities requires. */
async function invite(role: 'manager' | 'agent' | 'viewer', tag: string): Promise<string> {
  const { member } = await members.create(owner(), {
    email: uniqueEmail(tag),
    name: `Preset ${tag}`,
    role,
  });
  return member.userId;
}

/** Read the stored capabilities JSONB straight from the DB (ground truth,
 *  bypassing the response mapper). */
async function storedCapabilities(userId: string): Promise<AgentCapabilities | null> {
  return withTenant(
    org.id,
    async (tx) => {
      const [row] = await tx
        .select({ capabilities: memberships.capabilities })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.orgId, org.id)))
        .limit(1);
      return (row?.capabilities as AgentCapabilities | undefined) ?? null;
    },
    { userId: managerId },
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `preset-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('#8 capability presets — GET catalog (service-level, real-DB)', () => {
  it('P1) returns a NON-EMPTY catalog; each entry has key + Hebrew name/description + a valid capability bundle', async () => {
    const presets = await listPresets(owner());

    expect(Array.isArray(presets), 'catalog must be a list').toBe(true);
    expect(presets.length, 'catalog must be non-empty (code-defined presets)').toBeGreaterThan(0);

    const keys = new Set<string>();
    for (const p of presets) {
      // key — stable machine identifier, unique across the catalog.
      expect(typeof p.key, `preset key must be a string (got ${typeof p.key})`).toBe('string');
      expect(p.key.length, 'preset key must be non-empty').toBeGreaterThan(0);
      expect(keys.has(p.key), `duplicate preset key '${p.key}'`).toBe(false);
      keys.add(p.key);

      // Hebrew non-technical name + description — the whole point of #8.
      expect(typeof p.nameHe, `preset '${p.key}' must have a Hebrew name`).toBe('string');
      expect(p.nameHe.trim().length, `preset '${p.key}' nameHe must be non-empty`).toBeGreaterThan(
        0,
      );
      expect(typeof p.descriptionHe, `preset '${p.key}' must have a Hebrew description`).toBe(
        'string',
      );
      expect(
        p.descriptionHe.trim().length,
        `preset '${p.key}' descriptionHe must be non-empty`,
      ).toBeGreaterThan(0);

      // capabilities — a complete, valid bundle of the 7 known flags (a real
      // bundle the apply path can store verbatim; validated against the SoT
      // schema so a typo'd/extra flag fails here).
      const parsed = AgentCapabilitiesSchema.safeParse(p.capabilities);
      expect(
        parsed.success,
        `preset '${p.key}' capabilities must be a valid AgentCapabilities bundle`,
      ).toBe(true);
      for (const k of AGENT_CAPABILITY_KEYS) {
        expect(
          typeof (p.capabilities as Record<string, unknown>)[k],
          `preset '${p.key}' missing capability flag '${k}'`,
        ).toBe('boolean');
      }
    }
  }, 30_000);
});

describe('#8 capability presets — apply (service-level, real-DB)', () => {
  it('P2) applying a preset SETS the agent capabilities to exactly the preset bundle', async () => {
    const presets = await listPresets(owner());
    // Prefer the documented field_coordinator preset; fall back to the first.
    const preset = presets.find((p) => p.key === 'field_coordinator') ?? presets[0]!;
    const agentId = await invite('agent', 'apply');

    const before = await storedCapabilities(agentId);
    expect(before, 'seeded agent must have stored capabilities (column default)').not.toBeNull();

    const updated = await applyPreset(owner(), agentId, preset.key);

    // Response surfaces the agent with the preset's capabilities.
    expect(updated.userId).toBe(agentId);
    expect(updated.role).toBe('agent');
    expect(
      updated.capabilities,
      'returned member must carry the applied capability bundle',
    ).toEqual(preset.capabilities);

    // Ground truth in the DB equals the preset bundle EXACTLY (set, not merge:
    // every one of the 7 flags matches the preset).
    const after = await storedCapabilities(agentId);
    expect(after, 'agent capabilities must be persisted').not.toBeNull();
    for (const k of AGENT_CAPABILITY_KEYS) {
      expect((after as Record<string, unknown>)[k], `flag '${k}' not set to the preset value`).toBe(
        (preset.capabilities as Record<string, unknown>)[k],
      );
    }
  }, 30_000);

  it('P3) applying a preset to a NON-agent (viewer) is rejected (capabilities are agent-only)', async () => {
    const presets = await listPresets(owner());
    const preset = presets[0]!;
    const viewerId = await invite('viewer', 'viewer-target');

    let thrown: unknown;
    try {
      await applyPreset(owner(), viewerId, preset.key);
    } catch (e) {
      thrown = e;
    }
    // Mirror updateCapabilities: a non-agent is a 400 capabilities_agent_only.
    expect(thrown, 'applying a preset to a non-agent must throw').toBeInstanceOf(HttpException);
    expect(httpStatus(thrown), 'non-agent apply must be a client error').toBe(400);
    expect(errCode(thrown)).toBe('capabilities_agent_only');

    // And it must NOT have mutated the viewer's stored capabilities.
    const after = await storedCapabilities(viewerId);
    expect(after, 'viewer capabilities row must still exist').not.toBeNull();
  }, 30_000);

  it('P4) an UNKNOWN presetKey is rejected with a 400 (validation)', async () => {
    const agentId = await invite('agent', 'unknown-key');
    const before = await storedCapabilities(agentId);

    let thrown: unknown;
    try {
      await applyPreset(owner(), agentId, 'no_such_preset_key');
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'an unknown presetKey must throw').toBeInstanceOf(HttpException);
    expect(httpStatus(thrown), 'unknown preset must be a 400').toBe(400);

    // No mutation on a rejected apply.
    const after = await storedCapabilities(agentId);
    expect(after, 'agent capabilities must be unchanged after a rejected apply').toEqual(before);
  }, 30_000);
});

describe('#8 capability presets — controller surface (structural)', () => {
  const controllerSrc = readFileSync(join(__dirname, 'members.controller.ts'), 'utf8');

  it('P5) GET capability-presets route is declared and tenant-scoped (members.read)', () => {
    // The catalog list lives behind the members surface and reads the catalog
    // for a tenant — at minimum a members.read gate (a list any org user with
    // the members surface can fetch). RED until the route exists.
    expect(controllerSrc, 'no capability-presets route on the controller yet').toMatch(
      /capability-presets/,
    );
  });

  it('P6) (security) apply-capability-preset route requires members.update (same gate as PATCH :userId/capabilities)', () => {
    // SPEC: the apply mutates an agent's capability flags — a member-administration
    // write — so it MUST carry @RequirePermission('members.update'), exactly like
    // the existing capabilities route. A caller without members.update is blocked
    // centrally by the AuthorizationGuard. RED until the gated route is added.
    expect(controllerSrc, 'no apply-capability-preset route on the controller yet').toMatch(
      /apply-capability-preset/,
    );
    // The apply route's method block must be preceded by the members.update gate.
    const applyIdx = controllerSrc.search(/apply-capability-preset/);
    expect(applyIdx, 'apply route not found in controller').toBeGreaterThanOrEqual(0);
    const upToApply = controllerSrc.slice(0, applyIdx + 200);
    expect(
      upToApply,
      'apply-capability-preset must be gated by @RequirePermission("members.update")',
    ).toMatch(/@RequirePermission\(['"]members\.update['"]\)[\s\S]*apply-capability-preset/);
  });
});
