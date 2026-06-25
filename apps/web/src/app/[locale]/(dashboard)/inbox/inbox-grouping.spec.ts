/**
 * Inbox kind-grouping invariant — Autonomous Master Plan, Phase 1 (the Approval
 * Inbox, SCALE-READY slice).
 *
 * The inbox is NO LONGER a flat keyset wall: the ACCUMULATED feed is grouped by
 * proposal `kind` for at-a-glance triage. The bug this guards: grouping per
 * keyset PAGE fractures a kind's proposals across page boundaries. The fix is to
 * group the CONCATENATION of all loaded pages — so this pins `groupByKind` over a
 * two-page concatenation.
 *
 * `vitest` env is `node` here (no DOM), so we test the EXPORTED pure function
 * directly (same discipline as `documents-grouping.spec.ts`'s `groupByProjectParty`).
 */
import { describe, expect, it } from 'vitest';

import type { ProposalViewModel } from '@/models/proposal.vm';

import { groupByKind } from './inbox-list.client';

/** A minimal PII-free VM for the given id + kind (the grouping reads only id + kind). */
function vm(id: string, kind: string): ProposalViewModel {
  return {
    id,
    kind,
    whyTitle: 'why',
    approveLabel: 'approve',
    scopeLabel: 'scope',
    createdRelative: 'an hour ago',
    createdAtIso: '2026-06-24T08:00:00.000Z',
  };
}

describe('groupByKind (inbox accumulate-across-pages invariant)', () => {
  it('groups the CONCATENATION of two keyset pages into ONE group per kind', () => {
    // Page 1 and page 2 each carry the SAME kind split across the boundary.
    const page1 = [vm('a1', 'signature_request.reissue'), vm('b1', 'reminder.send')];
    const page2 = [vm('a2', 'signature_request.reissue'), vm('b2', 'reminder.send')];
    const groups = groupByKind([...page1, ...page2]);

    // ONE group per kind — NOT one per (page, kind).
    const reissue = groups.find((g) => g.kind === 'signature_request.reissue')!;
    const reminder = groups.find((g) => g.kind === 'reminder.send')!;
    expect(reissue.items.map((p) => p.id)).toEqual(['a1', 'a2']);
    expect(reminder.items.map((p) => p.id)).toEqual(['b1', 'b2']);
    expect(groups).toHaveLength(2);
  });

  it('orders known kinds canonically (chase-first, tasks last)', () => {
    const items = [
      vm('t1', 'task.create'),
      vm('r1', 'reminder.send'),
      vm('s1', 'signature_request.reissue'),
      vm('d1', 'document.chase.send'),
    ];
    expect(groupByKind(items).map((g) => g.kind)).toEqual([
      'signature_request.reissue',
      'reminder.send',
      'document.chase.send',
      'task.create',
    ]);
  });

  it('collapses unmapped kinds into ONE trailing generic group (never a raw kind)', () => {
    const items = [
      vm('s1', 'signature_request.reissue'),
      vm('x1', 'some.future.kind'),
      vm('x2', 'another.unknown'),
    ];
    const groups = groupByKind(items);
    const generic = groups.at(-1)!;
    expect(generic.kind).toBe('generic');
    expect(generic.isGeneric).toBe(true);
    expect(generic.items.map((p) => p.id)).toEqual(['x1', 'x2']);
    // The known kind keeps its own group, ahead of the generic tail.
    expect(groups[0]!.kind).toBe('signature_request.reissue');
  });

  it('an empty feed yields no groups', () => {
    expect(groupByKind([])).toEqual([]);
  });
});
