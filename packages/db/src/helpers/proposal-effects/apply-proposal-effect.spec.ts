/**
 * `applyProposalEffect` BOUNDARY spec (Autonomous Master Plan, wave 1.2).
 *
 * Pure boundary assertions (no DB): the dispatcher is the non-bypassable backstop
 * that refuses to mutate for ANY kind that is not `autoExecute`, regardless of
 * caller. PLUS the exhaustive-allowlist invariant: EVERY member of
 * `AUTO_EXECUTE_SAFE_KINDS` must classify `autoExecute` AND have a registered effect
 * — so adding an outbound/PII/floor kind to the allowlist is a CI failure, never a
 * prod escape. The REAL effect mutation (a system task row) is exercised against the
 * live DB by `proposals.service.spec.ts` + `proposal-producer-auto-execute.spec.ts`.
 */
import { classify, type AutonomyActionKind } from '@emapp/jobs/autonomy-policy';
import { describe, expect, it } from 'vitest';

import type { Proposal } from '../../schema/proposals';
import type { TenantTx } from '../../wrappers/with-tenant';

import {
  applyProposalEffect,
  AUTO_EXECUTE_SAFE_KINDS,
  ProposalEffectBoundaryError,
} from './apply-proposal-effect';
import type { ProposalEffectDeps } from './types';

// A tx that THROWS if ever touched — proves the boundary refusal happens BEFORE any
// DB work (the mutation never even starts for a refused kind).
const explodingTx = new Proxy(
  {},
  {
    get() {
      throw new Error('tx must not be touched when the boundary refuses');
    },
  },
) as unknown as TenantTx;

const deps: ProposalEffectDeps = { createdBy: null, audit: { actorId: null } };

function proposal(kind: string): Proposal {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: '00000000-0000-4000-8000-0000000000aa',
    kind,
    status: 'pending',
    scopeType: 'project',
    scopeId: '00000000-0000-4000-8000-0000000000bb',
    evidence: {},
    dedupKey: `${kind}:x`,
    actorType: 'system',
    expiresAt: null,
    appliedAt: null,
    createdAt: new Date(),
  } as unknown as Proposal;
}

describe('applyProposalEffect — the non-bypassable boundary', () => {
  it('REFUSES every non-autoExecute kind (outbound/PII/floor) — tx never touched', async () => {
    const ALL: AutonomyActionKind[] = [
      'reminder.send',
      'link.reissue.send',
      'share.renew.send',
      'invite.chase.send',
      'tenant.onboard.smsOtp',
      'document.chase.send',
      'tabu.parse.toDraft', // autoExecute-eligible by internal/reversible BUT pii:true → proposeConfirm
      'status.toApproved',
      'tabu.confirm.ownerships',
      'nationalId.export',
      'nationalId.erase.rtbf',
      'sensitivity.flipOn',
      'role.grant.owner',
      'provider.session.freeze',
      'gate6.docs.reEncrypt',
    ];
    for (const kind of ALL) {
      // Sanity: this kind really is NOT autoExecute (else the test is wrong).
      expect(classify({ kind }).decision).not.toBe('autoExecute');
      await expect(
        applyProposalEffect(explodingTx, kind, proposal(kind), deps),
      ).rejects.toBeInstanceOf(ProposalEffectBoundaryError);
    }
  });

  it('REFUSES an autoExecute kind that has NO registered effect (fail-closed)', async () => {
    // `signature_request.reissue` classifies autoExecute BUT is intentionally NOT in
    // the auto-safe registry (its real executor SENDS — the P0-2 trap). It must NOT be
    // applicable through this path.
    expect(classify({ kind: 'signature_request.reissue' }).decision).toBe('autoExecute');
    expect(
      (AUTO_EXECUTE_SAFE_KINDS as readonly string[]).includes('signature_request.reissue'),
    ).toBe(false);
    await expect(
      applyProposalEffect(
        explodingTx,
        'signature_request.reissue',
        proposal('signature_request.reissue'),
        deps,
      ),
    ).rejects.toThrow();
  });

  it('throws on an unknown kind (Zod fail-closed)', async () => {
    await expect(
      applyProposalEffect(
        explodingTx,
        'totally.made.up' as AutonomyActionKind,
        proposal('totally.made.up'),
        deps,
      ),
    ).rejects.toThrow();
  });
});

describe('AUTO_EXECUTE_SAFE_KINDS — the exhaustive allowlist invariant', () => {
  it('every member classifies autoExecute (no outbound/PII/floor kind can be listed)', () => {
    for (const kind of AUTO_EXECUTE_SAFE_KINDS) {
      const c = classify({ kind });
      expect(c.decision).toBe('autoExecute');
      expect(c.outbound).toBe(false);
      expect(c.pii).toBe(false);
    }
  });

  it('is non-empty and contains task.create (the one safe kind today)', () => {
    expect(AUTO_EXECUTE_SAFE_KINDS.length).toBeGreaterThan(0);
    expect(AUTO_EXECUTE_SAFE_KINDS).toContain('task.create');
  });
});
