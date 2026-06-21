/**
 * E2 Wave-2 A2 — `rankAttention` PURE-scorer unit spec.
 *
 * No DB, no Nest — just the deterministic ordering contract: most-urgent first,
 * stable `projectId` tie-break. Asserts the RELATIVE ordering the three pressure
 * signals (stall / expiry / consent-gap) produce, not the absolute weights.
 */
import {
  PULSE_EXPIRING_SOON_DAYS,
  PULSE_STALLED_DAYS,
  type ProjectPulseRow,
} from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { attentionScore, rankAttention } from './rank-attention';

/** Build a row with sane defaults; override the axis under test. */
function row(over: Partial<ProjectPulseRow> & { projectId: string }): ProjectPulseRow {
  return {
    projectId: over.projectId,
    projectName: over.projectName ?? `P-${over.projectId}`,
    lastSignatureAt: over.lastSignatureAt ?? null,
    signedThisWeek: over.signedThisWeek ?? 0,
    stalledDays: over.stalledDays ?? null,
    nextExpiryAt: over.nextExpiryAt ?? null,
    expiringSoon: over.expiringSoon ?? false,
    consentedPct: over.consentedPct ?? 0,
    metThreshold: over.metThreshold ?? false,
    basis: 'share',
    campaignDocumentId: over.campaignDocumentId ?? null,
    hasCampaign: over.hasCampaign ?? false,
  };
}

const ID = {
  a: '00000000-0000-0000-0000-00000000000a',
  b: '00000000-0000-0000-0000-00000000000b',
  c: '00000000-0000-0000-0000-00000000000c',
};

describe('attentionScore — per-axis pressure', () => {
  it('RA-1) a stalled project scores higher the longer it is stalled', () => {
    const mild = row({ projectId: ID.a, stalledDays: PULSE_STALLED_DAYS });
    const worse = row({ projectId: ID.a, stalledDays: PULSE_STALLED_DAYS + 30 });
    expect(attentionScore(worse)).toBeGreaterThan(attentionScore(mild));
  });

  it('RA-2) a project just under the stalled floor scores 0 on the stall axis', () => {
    // metThreshold:true zeroes the consent axis so we isolate stall pressure.
    const under = row({ projectId: ID.a, stalledDays: PULSE_STALLED_DAYS - 1, metThreshold: true });
    expect(attentionScore(under)).toBe(0);
  });

  it('RA-3) a NEVER-signed project (stalledDays null) is NOT treated as stalled', () => {
    // metThreshold:true zeroes the consent axis; with no stall + no expiry the
    // null-stalledDays row scores 0 on the stall axis (it is "not started",
    // not "stalled").
    const neverSigned = row({ projectId: ID.a, stalledDays: null, metThreshold: true });
    expect(attentionScore(neverSigned)).toBe(0);
  });

  it('RA-4) expiringSoon adds a fixed high bump', () => {
    const calm = row({ projectId: ID.a, metThreshold: true });
    const expiring = row({ projectId: ID.a, expiringSoon: true, metThreshold: true });
    expect(attentionScore(expiring)).toBeGreaterThan(attentionScore(calm));
  });

  it('RA-5) consent-gap pressure: further from target = higher; met threshold = 0 on that axis', () => {
    const far = row({ projectId: ID.a, consentedPct: 10, metThreshold: false });
    const near = row({ projectId: ID.a, consentedPct: 90, metThreshold: false });
    const met = row({ projectId: ID.a, consentedPct: 90, metThreshold: true });
    expect(attentionScore(far)).toBeGreaterThan(attentionScore(near));
    expect(attentionScore(met)).toBeLessThan(attentionScore(near));
  });
});

describe('rankAttention — ordering', () => {
  it('RA-6) orders most-urgent first (stalled+expiring+far beats calm+met)', () => {
    const urgent = row({
      projectId: ID.a,
      stalledDays: PULSE_STALLED_DAYS + 20,
      expiringSoon: true,
      consentedPct: 5,
      metThreshold: false,
    });
    const calm = row({ projectId: ID.b, consentedPct: 95, metThreshold: true });
    const ordered = rankAttention([calm, urgent]);
    expect(ordered.map((r) => r.projectId)).toEqual([ID.a, ID.b]);
  });

  it('RA-7) is a stable, deterministic projectId tie-break for equal scores', () => {
    // Two rows with IDENTICAL score (both met threshold, nothing urgent).
    const r1 = row({ projectId: ID.c, metThreshold: true });
    const r2 = row({ projectId: ID.a, metThreshold: true });
    const r3 = row({ projectId: ID.b, metThreshold: true });
    const ordered = rankAttention([r1, r2, r3]);
    expect(ordered.map((r) => r.projectId)).toEqual([ID.a, ID.b, ID.c]);
  });

  it('RA-8) is pure — does not mutate the input array', () => {
    const input = [row({ projectId: ID.b }), row({ projectId: ID.a, expiringSoon: true })];
    const snapshot = input.map((r) => r.projectId);
    rankAttention(input);
    expect(input.map((r) => r.projectId)).toEqual(snapshot);
  });

  it('RA-9) expiring beats a moderate consent gap (time-critical wins)', () => {
    const expiring = row({ projectId: ID.a, expiringSoon: true, consentedPct: 80 });
    const gappy = row({ projectId: ID.b, consentedPct: 30, expiringSoon: false });
    const ordered = rankAttention([gappy, expiring]);
    // EXPIRY_WEIGHT (50) > CONSENT_GAP_WEIGHT(0.5) * 70 (=35) → expiring first.
    expect(ordered[0]!.projectId).toBe(ID.a);
  });
});

describe('thresholds are imported from shared-types (no drift)', () => {
  it('RA-10) the spec reads the SAME tunables the scorer reads', () => {
    expect(PULSE_STALLED_DAYS).toBeGreaterThan(0);
    expect(PULSE_EXPIRING_SOON_DAYS).toBeGreaterThan(0);
  });
});
