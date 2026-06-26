/**
 * `project-perception.ts` — contract tests (Autonomous Managing System, wave 1.1).
 * Proves the shared FE/BE contract and its DECIDE→ACT map are well-formed:
 *   - `ProjectPerceptionSchema` ACCEPTS a representative row of the exact shape
 *     the `@emapp/db` assembler emits (the cross-package binding — the db spec
 *     `project-perception.assembler.spec.ts` pins the assembler to this same
 *     key shape; this side proves that shape is a valid contract instance);
 *   - `.strict()` REJECTS any stray field (the structural PII guard);
 *   - `attentionReasonToActionKind` is TOTAL over `AttentionReason` and every
 *     value is a real `AutonomyActionKind` or `null` (the P1-1 correction — no
 *     junk kinds invented to satisfy totality);
 *   - `PROJECT_TERMINAL_STATUSES` is exactly the two D.18 terminal statuses
 *     (binds to the db-side `PERCEPTION_TERMINAL_STATUSES` mirror).
 */
import { AutonomyActionKindSchema } from '@emapp/jobs';
import { describe, expect, it } from 'vitest';

import { PROJECT_TERMINAL_STATUSES } from './project';
import {
  ALL_ATTENTION_REASONS,
  ProjectPerceptionSchema,
  attentionReasonToActionKind,
  actionKindForAttentionReason,
} from './project-perception';

/** A representative row exactly matching the db assembler's emitted shape. */
const SAMPLE_ROW = {
  projectId: '11111111-1111-4111-8111-111111111111',
  projectName: 'בניין הבדיקה',
  projectType: 'tama38_1',
  status: 'gathering_signatures',
  isTerminal: false,
  archivedAt: null,
  signatures: {
    signed: 1,
    pending: 1,
    totalApartments: 2,
    apartmentsConsented: 1,
    consentedPct: 50,
    targetSignaturePct: 66,
    metThreshold: false,
    basis: 'share' as const,
  },
  activity: {
    lastSignatureAt: '2026-06-06T12:00:00.000Z',
    oldestPendingAt: '2026-05-17T12:00:00.000Z',
    oldestPendingAgeDays: 40,
    nextExpiryAt: '2026-07-01T12:00:00.000Z',
  },
  holdouts: {
    activeOwners: 2,
    unsignedOwners: 1,
  },
  missingRequiredDocs: [
    { track: 'tama38', docType: 'blueprint' },
    { track: 'tama38', docType: 'land_registry' },
  ],
  atRisk: true,
};

describe('ProjectPerceptionSchema — the PII-free read-model contract', () => {
  it('ACCEPTS the representative assembler row shape', () => {
    expect(() => ProjectPerceptionSchema.parse(SAMPLE_ROW)).not.toThrow();
  });

  it('ACCEPTS an empty / on-track row (nullable activity, zero counts)', () => {
    const empty = {
      ...SAMPLE_ROW,
      signatures: {
        ...SAMPLE_ROW.signatures,
        signed: 0,
        pending: 0,
        totalApartments: 0,
        apartmentsConsented: 0,
        consentedPct: 0,
        targetSignaturePct: null,
        metThreshold: false,
      },
      activity: {
        lastSignatureAt: null,
        oldestPendingAt: null,
        oldestPendingAgeDays: null,
        nextExpiryAt: null,
      },
      holdouts: { activeOwners: 0, unsignedOwners: 0 },
      missingRequiredDocs: [],
      atRisk: false,
    };
    expect(() => ProjectPerceptionSchema.parse(empty)).not.toThrow();
  });

  it('REJECTS a stray field (the .strict PII guard — no owner name can be smuggled)', () => {
    const withPii = { ...SAMPLE_ROW, ownerName: 'דנה כהן' };
    expect(() => ProjectPerceptionSchema.parse(withPii)).toThrow();
  });

  it('REJECTS an out-of-range percent', () => {
    const bad = {
      ...SAMPLE_ROW,
      signatures: { ...SAMPLE_ROW.signatures, consentedPct: 150 },
    };
    expect(() => ProjectPerceptionSchema.parse(bad)).toThrow();
  });
});

describe('attentionReasonToActionKind — TOTAL DECIDE→ACT map', () => {
  it('maps EVERY AttentionReason to a real AutonomyActionKind or explicit null', () => {
    for (const reason of ALL_ATTENTION_REASONS) {
      expect(reason in attentionReasonToActionKind).toBe(true);
      const kind = attentionReasonToActionKind[reason];
      if (kind !== null) {
        // Must be a REAL kind from the canonical taxonomy — never a junk string.
        expect(AutonomyActionKindSchema.options).toContain(kind);
      }
      // The helper returns the same value (no undefined ever).
      expect(actionKindForAttentionReason(reason)).toBe(kind);
    }
  });

  it('perceive-only reasons map to null (P1-1 — no junk kinds to satisfy totality)', () => {
    expect(attentionReasonToActionKind.at_risk).toBeNull();
    expect(attentionReasonToActionKind.on_track).toBeNull();
  });

  it('action-driving reasons map to their canonical kinds', () => {
    expect(attentionReasonToActionKind.signature_stalled).toBe('reminder.send');
    expect(attentionReasonToActionKind.signature_expiring).toBe('signature_request.reissue');
    expect(attentionReasonToActionKind.holdout_blocking).toBe('task.create');
    expect(attentionReasonToActionKind.missing_required_doc).toBe('task.create');
  });
});

describe('PROJECT_TERMINAL_STATUSES — binds the db-side mirror', () => {
  it('is exactly the two D.18 terminal statuses', () => {
    expect([...PROJECT_TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed']);
  });
});
