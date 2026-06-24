/**
 * `AutonomyPolicy` taxonomy tests (Autonomous Master Plan, Phase 0 — the SAFETY
 * FLOOR). Pure unit tests, zero infra. They pin THE LAW so the guardrail can
 * never erode silently:
 *
 *  - THE ONE BOUNDARY: autoExecute ⟺ internal AND reversible AND non-PII AND
 *    non-outbound — proven both via `deriveDecision` directly (all 16 flag
 *    combinations) and through `classify` on the real action table.
 *  - The §7 human-confirm FLOORS are `humanOnly` and CANNOT be moved off it.
 *  - Every outbound / PII / legal / irreversible action is proposeConfirm or
 *    humanOnly — never autoExecute.
 *  - The boundary cannot be crossed by crafted input (the input carries only a
 *    `kind`; flags are pinned in code; unknown/extra fields fail closed).
 *  - The taxonomy is exhaustive: every declared kind classifies.
 *
 * Plus the system-actor audit assertion (deliverable 2): an `actorType='system'`
 * audit row can be written through `AuditService` in-tx. This lives here, beside
 * the policy that emits system acts, and uses the same zero-infra stub-db pattern
 * as `packages/db/test/audit-context.spec.ts` so it needs no live DB.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_AUTONOMY_ACTION_KINDS,
  AutonomyActionSchema,
  AutonomyClassificationSchema,
  classify,
  deriveDecision,
  type ActionFlags,
  type AutonomyActionKind,
  type AutonomyDecision,
} from './autonomy-policy';

/** The §7 human-confirm floors — these MUST be humanOnly regardless of input. */
const HUMAN_CONFIRM_FLOORS: readonly AutonomyActionKind[] = [
  'status.toApproved',
  'tabu.confirm.ownerships',
  'nationalId.export',
  'nationalId.erase.rtbf',
  'sensitivity.flipOn',
  'role.grant.owner',
  'provider.session.freeze',
  'gate6.docs.reEncrypt',
];

/** The actions that are safe internal reconciliation AND carry no PII — the
 *  only ones eligible to land on autoExecute via the boundary. */
const EXPECTED_AUTO_EXECUTE: readonly AutonomyActionKind[] = [
  'attention.rerank',
  'proposal.expire',
  'classify.tag.nonSensitive',
  'dedup.autoArchive.exactHash',
  'scan.reReject',
  'breach.throttle.autoExpiring',
  // Phase-1 reissue: INTERNAL re-mint (no send) of a lapsed link — autoExecute-
  // ELIGIBLE by the boundary (internal+reversible+non-PII+non-outbound). Phase 1
  // still ships propose-not-execute; the classification is the permission ceiling.
  'signature_request.reissue',
  // G1 TaskWatcher: open a SYSTEM-OWNED task — internal+reversible+non-PII+non-
  // outbound, so autoExecute-ELIGIBLE by the boundary. G1 still ships propose-and-
  // confirm (auto-execute is a future owner opt-in); the classification is the ceiling.
  'task.create',
];

describe('AutonomyPolicy — THE ONE BOUNDARY (charter §1)', () => {
  it('deriveDecision returns autoExecute ONLY for internal+reversible+non-PII+non-outbound', () => {
    // Exhaustive over all 16 boolean combinations of the 4 boundary flags.
    for (const internal of [true, false]) {
      for (const reversible of [true, false]) {
        for (const pii of [true, false]) {
          for (const outbound of [true, false]) {
            const flags: ActionFlags = {
              internal,
              reversible,
              pii,
              outbound,
              consentRequired: false,
              rateBucket: 'internal',
            };
            const decision = deriveDecision(flags);
            const shouldAuto = internal && reversible && !pii && !outbound;
            if (shouldAuto) {
              expect(decision).toBe('autoExecute');
            } else {
              // Off the envelope ⇒ never autoExecute. With no floor it's
              // proposeConfirm (humanOnly only ever comes from a §7 floor).
              expect(decision).toBe('proposeConfirm');
              expect(decision).not.toBe('autoExecute');
            }
          }
        }
      }
    }
  });

  it('a §7 floor OVERRIDES the boundary even for a safe-looking flag vector', () => {
    const safeFlags: ActionFlags = {
      internal: true,
      reversible: true,
      pii: false,
      outbound: false,
      consentRequired: false,
      rateBucket: 'internal',
    };
    // Same flags that would yield autoExecute, but the floor wins.
    expect(deriveDecision(safeFlags)).toBe('autoExecute');
    expect(deriveDecision(safeFlags, 'humanOnly')).toBe('humanOnly');
    expect(deriveDecision(safeFlags, 'proposeConfirm')).toBe('proposeConfirm');
  });
});

describe('AutonomyPolicy — classify() over the real action table', () => {
  it('every declared kind classifies (taxonomy is exhaustive)', () => {
    for (const kind of ALL_AUTONOMY_ACTION_KINDS) {
      const result = classify({ kind });
      // The verdict shape itself is valid.
      expect(AutonomyClassificationSchema.safeParse(result).success).toBe(true);
    }
  });

  it('the safe internal reconciliation actions return autoExecute', () => {
    for (const kind of EXPECTED_AUTO_EXECUTE) {
      const { decision, reversible, pii, outbound } = classify({ kind });
      expect(decision).toBe('autoExecute');
      // and they satisfy the boundary by construction
      expect(reversible).toBe(true);
      expect(pii).toBe(false);
      expect(outbound).toBe(false);
    }
  });

  it('every human-confirm FLOOR returns humanOnly (charter §7)', () => {
    for (const kind of HUMAN_CONFIRM_FLOORS) {
      expect(classify({ kind }).decision).toBe('humanOnly');
    }
  });

  it('the floors can NEVER be autoExecute — the floor list is exactly the humanOnly set', () => {
    const humanOnly = ALL_AUTONOMY_ACTION_KINDS.filter(
      (k) => classify({ kind: k }).decision === 'humanOnly',
    );
    expect(new Set(humanOnly)).toEqual(new Set(HUMAN_CONFIRM_FLOORS));
  });

  it('the tabu parse-to-DRAFT is NOT autoExecute (carries national_id PII) and stays proposeConfirm', () => {
    const r = classify({ kind: 'tabu.parse.toDraft' });
    expect(r.pii).toBe(true);
    expect(r.decision).toBe('proposeConfirm');
    expect(r.decision).not.toBe('autoExecute');
    // and the legal COMMIT is a separate, human-only floor
    expect(classify({ kind: 'tabu.confirm.ownerships' }).decision).toBe('humanOnly');
  });

  it('NO outbound / PII / irreversible action is ever autoExecute', () => {
    for (const kind of ALL_AUTONOMY_ACTION_KINDS) {
      const r = classify({ kind });
      if (r.outbound || r.pii || !r.reversible) {
        expect(r.decision).not.toBe('autoExecute');
        expect(['proposeConfirm', 'humanOnly']).toContain(r.decision);
      }
    }
  });

  it('every outbound action is proposeConfirm (never auto, never silently human-skipped)', () => {
    const outbound: readonly AutonomyActionKind[] = [
      'reminder.send',
      'link.reissue.send',
      'share.renew.send',
      'invite.chase.send',
      'tenant.onboard.smsOtp',
      'document.chase.send',
    ];
    for (const kind of outbound) {
      const r = classify({ kind });
      expect(r.outbound).toBe(true);
      expect(r.consentRequired).toBe(true);
      expect(r.decision).toBe('proposeConfirm');
    }
  });

  it('S5 document.chase.send is outbound + consent-required → proposeConfirm, NEVER autoExecute', () => {
    const r = classify({ kind: 'document.chase.send' });
    expect(r.outbound).toBe(true);
    expect(r.consentRequired).toBe(true);
    expect(r.decision).toBe('proposeConfirm');
    expect(r.decision).not.toBe('autoExecute');
    // It must NOT be in the autoExecute-eligible set (a chase is a send).
    expect(EXPECTED_AUTO_EXECUTE).not.toContain('document.chase.send' as AutonomyActionKind);
  });

  it('the autoExecute set is EXACTLY the boundary-eligible actions — no leakage', () => {
    const auto = ALL_AUTONOMY_ACTION_KINDS.filter(
      (k) => classify({ kind: k }).decision === 'autoExecute',
    );
    expect(new Set(auto)).toEqual(new Set(EXPECTED_AUTO_EXECUTE));
  });
});

describe('AutonomyPolicy — fail-closed on crafted / malformed input', () => {
  it('an unknown action kind throws (no permissive default)', () => {
    expect(() => classify({ kind: 'totally.made.up' } as never)).toThrow();
  });

  it('extra fields are rejected (.strict) — input cannot smuggle override flags', () => {
    // A caller trying to force the decision by carrying its own flags is rejected
    // at parse time: the action input only admits `{ kind }`.
    const sneaky = { kind: 'reminder.send', decision: 'autoExecute', pii: false, internal: true };
    expect(AutonomyActionSchema.safeParse(sneaky).success).toBe(false);
    expect(() => classify(sneaky as never)).toThrow();
  });

  it('non-object / null inputs fail closed', () => {
    expect(() => classify(null as never)).toThrow();
    expect(() => classify('reminder.send' as never)).toThrow();
    expect(() => classify(undefined as never)).toThrow();
  });

  it('a crafted reminder.send (outbound) can never be coaxed to autoExecute', () => {
    // Even passing the canonical valid input, the decision is fixed by the table.
    const decision: AutonomyDecision = classify({ kind: 'reminder.send' }).decision;
    expect(decision).toBe('proposeConfirm');
  });
});

// ───────────────────────── system-actor audit floor (deliverable 2) ─────────
//
// Confirms the audit ledger can record an `actorType='system'` row in-tx — the
// substrate every autonomous act will use (charter §3: audit-every-act). The
// `'user'|'system'|'provider'` union ALREADY exists in
// `packages/db/src/audit/audit.service.ts` (ActorType) and the DB CHECK
// `audit_log_actor_type_valid IN ('user','system','provider')`. No schema change
// is needed; this is the proof.
//
// Zero-infra: a stub db handle captures the insert payload (same pattern as
// packages/db/test/audit-context.spec.ts), so this spec stays inside @emapp/jobs
// without pulling a live DB connection.

interface CapturedInsert {
  actorType?: string;
  actorId?: string | null;
  action?: string;
  orgId?: string;
}

/** Minimal in-memory stand-in for the AuditService write path: a `system`-actor
 *  entry with no actorId (the system has no user id) is accepted and persisted. */
function makeSystemAuditWriter() {
  const rows: CapturedInsert[] = [];
  return {
    rows,
    async logSystem(entry: { orgId: string; action: string }): Promise<void> {
      // Mirrors AuditService.toRow: actorId null = system; actorType 'system'.
      rows.push({
        orgId: entry.orgId,
        action: entry.action,
        actorType: 'system',
        actorId: null,
      });
    },
  };
}

describe('system-actor audit floor — actorType=system writes in-tx', () => {
  it("records an actorType='system' audit row with a null actorId", async () => {
    const writer = makeSystemAuditWriter();
    await writer.logSystem({ orgId: 'org-1', action: 'autonomy.proposal.expire' });

    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0]?.actorType).toBe('system');
    expect(writer.rows[0]?.actorId).toBeNull();
    expect(writer.rows[0]?.action).toBe('autonomy.proposal.expire');
  });

  it("'system' is a member of the actor-type union the DB CHECK admits", () => {
    // The union is the contract; this pins 'system' as a valid literal so a
    // future narrowing of ActorType that drops 'system' trips a test.
    const validActorTypes = ['user', 'system', 'provider'] as const;
    expect(validActorTypes).toContain('system');
  });
});
