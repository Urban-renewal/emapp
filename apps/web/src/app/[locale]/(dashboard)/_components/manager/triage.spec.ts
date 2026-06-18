/**
 * E2.1 home mission-control — triage logic guard (docs/DESIGN-NORTH-STAR.md).
 *
 * `triage.ts` is the PURE heart of the manager home: it folds the real project
 * list into the pulse + exception + "needs a look" view-models the home renders.
 * The north-star honesty rule (never fabricate) lives or dies here, so this spec
 * pins:
 *   - the consent-gate math (ceil of targetConsentPct% of apartments);
 *   - the kind classification (past / near / not-started / in-progress / …);
 *   - that a project with NO usable counts degrades to a STATE-only kind with
 *     null numerics (never a guessed number);
 *   - the pulse counts;
 *   - urgency ordering + the exception cap;
 *   - archived projects are excluded.
 *
 * Pure module → no React, no mocks. A `ProjectViewModel` factory keeps each
 * case to just the fields triage reads.
 */
import { describe, expect, it } from 'vitest';

import type { ProjectViewModel } from '@/models/project.vm';

import { computeHomeTriage, deriveProjectTriage, NEAR_THRESHOLD_WINDOW } from './triage';

/** Minimal `ProjectViewModel` — only the fields triage reads matter. */
function vm(over: Partial<ProjectViewModel>): ProjectViewModel {
  return {
    id: 'p',
    name: 'פרויקט',
    type: 'tama38_1',
    typeLabel: 'תמ"א 38/1',
    status: 'gathering_signatures',
    statusLabel: 'איסוף חתימות',
    statusColor: 'amber',
    targetConsentPct: 66,
    signatureMilestones: [],
    description: null,
    developerName: null,
    developerCompanyId: null,
    existingUnits: null,
    plannedUnits: null,
    extraAreaSqm: null,
    relocationType: null,
    relocationNotes: null,
    futureTrackLabel: null,
    block: null,
    parcel: null,
    subparcel: null,
    isArchived: false,
    createdRelative: 'היום',
    createdAtIso: '2026-06-18T00:00:00.000Z',
    buildingsCount: 1,
    unitsCount: undefined,
    signaturesPendingCount: undefined,
    signaturesSignedCount: undefined,
    agentsCount: 0,
    ...over,
  };
}

describe('deriveProjectTriage — gate math + classification', () => {
  it('computes the gate as ceil(targetConsentPct% of apartments)', () => {
    // 66% of 22 = 14.52 → gate 15.
    const t = deriveProjectTriage(
      vm({ unitsCount: 22, signaturesSignedCount: 10, targetConsentPct: 66 }),
    );
    expect(t.gate).toBe(15);
    expect(t.total).toBe(22);
    expect(t.signed).toBe(10);
    expect(t.remainingToGate).toBe(5);
    expect(t.kind).toBe('in_progress');
  });

  it('flags near_threshold within NEAR_THRESHOLD_WINDOW signatures of the gate', () => {
    // gate 15, signed 14 → 1 short → near.
    const near = deriveProjectTriage(
      vm({ unitsCount: 22, signaturesSignedCount: 14, targetConsentPct: 66 }),
    );
    expect(near.remainingToGate).toBe(1);
    expect(near.kind).toBe('near_threshold');
    expect(near.isException).toBe(true);

    // Exactly at the window edge is still near.
    const edge = deriveProjectTriage(
      vm({
        unitsCount: 22,
        signaturesSignedCount: 15 - NEAR_THRESHOLD_WINDOW,
        targetConsentPct: 66,
      }),
    );
    expect(edge.kind).toBe('near_threshold');
  });

  it('flags past_threshold when signed >= gate', () => {
    const t = deriveProjectTriage(
      vm({ unitsCount: 22, signaturesSignedCount: 15, targetConsentPct: 66 }),
    );
    expect(t.kind).toBe('past_threshold');
    // A win, not an alarm — not an exception.
    expect(t.isException).toBe(false);
  });

  it('flags not_started for an active collection sitting at zero signatures', () => {
    const t = deriveProjectTriage(
      vm({ unitsCount: 22, signaturesSignedCount: 0, targetConsentPct: 66 }),
    );
    expect(t.kind).toBe('not_started');
    expect(t.isException).toBe(true);
  });

  it('NEVER fabricates numbers when counts are missing — STATE-only, null numerics', () => {
    // No unitsCount / signaturesSignedCount on the wire → no gate, null numerics.
    const t = deriveProjectTriage(vm({ unitsCount: undefined, signaturesSignedCount: undefined }));
    expect(t.gate).toBeNull();
    expect(t.signed).toBeNull();
    expect(t.total).toBeNull();
    expect(t.remainingToGate).toBeNull();
    // gathering + unknown signed → not classified as near/past; falls to a state.
    expect(['not_started', 'in_progress']).toContain(t.kind);
  });

  it('degrades to in_progress (not near/past) when target is null even with counts', () => {
    const t = deriveProjectTriage(
      vm({ unitsCount: 22, signaturesSignedCount: 20, targetConsentPct: null }),
    );
    expect(t.gate).toBeNull();
    // Real counts are still surfaced…
    expect(t.signed).toBe(20);
    expect(t.total).toBe(22);
    // …but with no target there is no gate to be "near" or "past".
    expect(t.kind).toBe('in_progress');
  });

  it('maps terminal/pre-collection statuses to their own kinds', () => {
    expect(deriveProjectTriage(vm({ status: 'completed' })).kind).toBe('completed');
    expect(deriveProjectTriage(vm({ status: 'cancelled' })).kind).toBe('cancelled');
    expect(deriveProjectTriage(vm({ status: 'planning' })).kind).toBe('pre_collection');
    expect(deriveProjectTriage(vm({ status: 'approved' })).kind).toBe('pre_collection');
    expect(deriveProjectTriage(vm({ status: 'in_construction' })).kind).toBe('pre_collection');
  });

  it('caps the gate at the apartment count (never asks for more than 100%)', () => {
    const t = deriveProjectTriage(
      vm({ unitsCount: 3, signaturesSignedCount: 3, targetConsentPct: 100 }),
    );
    expect(t.gate).toBe(3);
    expect(t.kind).toBe('past_threshold');
  });
});

describe('computeHomeTriage — pulse, exceptions, ordering', () => {
  const projects: ProjectViewModel[] = [
    vm({
      id: 'a',
      status: 'gathering_signatures',
      unitsCount: 10,
      signaturesSignedCount: 9,
      targetConsentPct: 66,
    }), // near (gate 7 → past actually)
    vm({
      id: 'b',
      status: 'gathering_signatures',
      unitsCount: 20,
      signaturesSignedCount: 13,
      targetConsentPct: 66,
    }), // gate 14 → near (1 short)
    vm({
      id: 'c',
      status: 'gathering_signatures',
      unitsCount: 20,
      signaturesSignedCount: 0,
      targetConsentPct: 66,
    }), // not_started
    vm({
      id: 'd',
      status: 'completed',
      unitsCount: 10,
      signaturesSignedCount: 10,
      targetConsentPct: 66,
    }), // completed
    vm({ id: 'e', status: 'planning' }), // pre_collection
    vm({ id: 'f', status: 'cancelled' }), // cancelled
    vm({
      id: 'g',
      isArchived: true,
      status: 'gathering_signatures',
      unitsCount: 20,
      signaturesSignedCount: 0,
    }), // archived → excluded
  ];

  it('counts the pulse from live (non-archived) projects', () => {
    const { pulse, total } = computeHomeTriage(projects);
    // Live = a,b,c,d,e,f (g archived). active = not completed/cancelled = a,b,c,e.
    expect(total).toBe(6);
    expect(pulse.active).toBe(4);
    expect(pulse.gathering).toBe(3); // a,b,c (g excluded as archived)
    expect(pulse.notStarted).toBe(1); // c
    expect(pulse.pastThreshold).toBe(1); // a (gate 7, signed 9)
  });

  it('surfaces only exception kinds (near / not-started), most-urgent first', () => {
    const { exceptions } = computeHomeTriage(projects);
    const ids = exceptions.map((e) => e.project.id);
    // b (near) ranks above c (not_started); a is past-threshold (not an exception).
    expect(ids).toEqual(['b', 'c']);
  });

  it('caps the exception + attention lists', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      vm({ id: `n${i}`, status: 'gathering_signatures', unitsCount: 10, signaturesSignedCount: 0 }),
    );
    const { exceptions, needsAttention } = computeHomeTriage(many, {
      maxExceptions: 4,
      maxAttention: 5,
    });
    expect(exceptions).toHaveLength(4);
    expect(needsAttention).toHaveLength(5);
  });

  it('excludes archived projects from the lists', () => {
    const { needsAttention } = computeHomeTriage(projects);
    expect(needsAttention.map((t) => t.project.id)).not.toContain('g');
  });
});
