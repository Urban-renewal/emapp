import type { DocumentScanStatus } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import type { DocumentViewModel } from '@/models/document.vm';

import { documentScope, groupByProjectParty } from './documents-list.client';

/**
 * The "כל המסמכים" accumulate-across-pages invariant (G2 fix). The grouping is
 * the single source of truth the view renders; the bug was that it ran over ONE
 * 25-row keyset page, so a project's docs SPLIT across a page boundary used to
 * land in different page-groups and "attention-first" only ordered within a
 * page. The fix accumulates every loaded page into one set BEFORE grouping;
 * these tests pin that grouping the CONCATENATION of pages collapses a project's
 * docs into ONE group with combined counts.
 */

const UNASSIGNED = 'ללא שיוך לפרויקט';

function doc(p: Partial<DocumentViewModel> & { id: string }): DocumentViewModel {
  return {
    name: `doc-${p.id}`,
    type: 'agreement',
    typeLabel: 'הסכם',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    sizeLabel: '100 B',
    isArchived: false,
    createdRelative: 'לפני יום',
    projectId: null,
    apartmentId: null,
    isSensitive: false,
    scanStatus: 'clean' as DocumentScanStatus,
    scanStatusLabel: 'תקין',
    isScanClean: true,
    projectName: null,
    apartmentName: null,
    ...p,
  };
}

describe('groupByProjectParty (accumulate-across-pages)', () => {
  it('merges a project whose docs span two keyset pages into ONE group', () => {
    // Project A has 2 docs; one arrives on "page 1", one on "page 2". The OLD
    // per-page grouping would render two separate A-groups (one per page). The
    // accumulated set must yield a SINGLE group for A with count 2.
    const page1 = [
      doc({ id: 'a1', projectId: 'A', projectName: 'מגדל א' }),
      doc({ id: 'b1', projectId: 'B', projectName: 'מגדל ב' }),
    ];
    const page2 = [
      doc({ id: 'a2', projectId: 'A', projectName: 'מגדל א' }),
      doc({ id: 'c1', projectId: 'C', projectName: 'מגדל ג' }),
    ];

    const perPageA = [
      ...groupByProjectParty(page1, UNASSIGNED).filter((g) => g.projectId === 'A'),
      ...groupByProjectParty(page2, UNASSIGNED).filter((g) => g.projectId === 'A'),
    ];
    // OLD behaviour: A appears once per page → two groups, each count 1.
    expect(perPageA).toHaveLength(2);

    const accumulated = groupByProjectParty([...page1, ...page2], UNASSIGNED);
    const aGroups = accumulated.filter((g) => g.projectId === 'A');
    // FIXED behaviour: exactly ONE group for A across both pages.
    expect(aGroups).toHaveLength(1);
    expect(aGroups[0]?.count).toBe(2);
    expect(accumulated.map((g) => g.projectId).sort()).toEqual(['A', 'B', 'C']);
  });

  it('dedupes nothing it should not, and places org-level docs in the unassigned group LAST', () => {
    const docs = [
      doc({ id: 'a1', projectId: 'A', projectName: 'מגדל א' }),
      doc({ id: 'o1', projectId: null }),
      doc({ id: 'a2', projectId: 'A', projectName: 'מגדל א' }),
    ];
    const groups = groupByProjectParty(docs, UNASSIGNED);
    expect(groups).toHaveLength(2);
    // Project group keeps both A docs; the org group is LAST.
    const last = groups[groups.length - 1];
    expect(last?.projectId).toBeNull();
    expect(last?.projectName).toBe(UNASSIGNED);
    expect(groups.find((g) => g.projectId === 'A')?.count).toBe(2);
  });
});

describe('documentScope', () => {
  it('resolves apartment > project > org from parent linkage', () => {
    expect(documentScope(doc({ id: '1', apartmentId: 'ap', projectId: 'pr' }))).toBe('apartment');
    expect(documentScope(doc({ id: '2', projectId: 'pr' }))).toBe('project');
    expect(documentScope(doc({ id: '3' }))).toBe('org');
  });
});
