/**
 * Phase 4a S7 — pin the Wire → ViewModel adapter for Document.
 *
 * Coverage: exhaustive DocumentTypeEnum × HE/EN labels, size-byte
 * humanization (B/KB/MB boundaries), isArchived toggle, parent
 * linkage pass-through.
 */
import { DocumentSchema, DocumentTypeEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_TYPE_LABELS_EN,
  DOCUMENT_TYPE_LABELS_HE,
  toDocumentViewModel,
  toDocumentViewModels,
} from './document';

function baseDoc(over: Partial<import('@emapp/shared-types').Document> = {}) {
  return DocumentSchema.parse({
    id: '11111111-1111-1111-1111-111111111111',
    organizationId: '22222222-2222-2222-2222-222222222222',
    projectId: null,
    apartmentId: null,
    name: 'invoice.pdf',
    type: 'contract',
    mimeType: 'application/pdf',
    sizeBytes: 12345,
    contentHash: 'a'.repeat(64),
    uploadedBy: '33333333-3333-3333-3333-333333333333',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toDocumentViewModel', () => {
  it('1) HE labels cover every type', () => {
    const k = Object.keys(DOCUMENT_TYPE_LABELS_HE).sort();
    expect(k).toEqual([...DocumentTypeEnum.options].sort());
  });

  it('2) EN labels cover every type', () => {
    const k = Object.keys(DOCUMENT_TYPE_LABELS_EN).sort();
    expect(k).toEqual([...DocumentTypeEnum.options].sort());
  });

  it('3) sizeLabel: bytes when under 1KB', () => {
    expect(toDocumentViewModel(baseDoc({ sizeBytes: 500 })).sizeLabel).toBe('500 B');
  });

  it('4) sizeLabel: KB with 1 decimal when under 1MB', () => {
    expect(toDocumentViewModel(baseDoc({ sizeBytes: 12_345 })).sizeLabel).toBe('12.1 KB');
  });

  it('5) sizeLabel: MB with 1 decimal when over 1MB', () => {
    expect(toDocumentViewModel(baseDoc({ sizeBytes: 5_242_880 })).sizeLabel).toBe('5.0 MB');
  });

  it('6) isArchived toggle', () => {
    expect(
      toDocumentViewModel(baseDoc({ archivedAt: new Date('2026-05-22T00:00:00Z') })).isArchived,
    ).toBe(true);
    expect(toDocumentViewModel(baseDoc()).isArchived).toBe(false);
  });

  it('7) projectId / apartmentId pass-through', () => {
    const vm = toDocumentViewModel(
      baseDoc({
        projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        apartmentId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      }),
    );
    expect(vm.projectId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(vm.apartmentId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('8) toDocumentViewModels preserves order', () => {
    const arr = toDocumentViewModels([
      baseDoc({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'A.pdf' }),
      baseDoc({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'B.pdf' }),
    ]);
    expect(arr.map((d) => d.name)).toEqual(['A.pdf', 'B.pdf']);
  });
});
