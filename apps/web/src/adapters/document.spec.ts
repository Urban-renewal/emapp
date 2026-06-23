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
  it('1) HE labels cover every curated upload type', () => {
    for (const t of DocumentTypeEnum.options) {
      expect(DOCUMENT_TYPE_LABELS_HE[t], `HE label for ${t}`).toBeTruthy();
    }
  });

  it('2) EN labels cover every curated upload type', () => {
    for (const t of DocumentTypeEnum.options) {
      expect(DOCUMENT_TYPE_LABELS_EN[t], `EN label for ${t}`).toBeTruthy();
    }
  });

  it('2b) the REAL urban-renewal types parse + have labels (DV-MGR-DOCS regression)', () => {
    for (const t of ['agreement', 'blueprint', 'regulation']) {
      const vm = toDocumentViewModel(baseDoc({ type: t }));
      expect(vm.type).toBe(t);
      expect(vm.typeLabel, `label for ${t}`).toBeTruthy();
    }
  });

  it('2c) an unknown free-text type parses + falls back to a non-blank label', () => {
    const vm = toDocumentViewModel(baseDoc({ type: 'some_imported_type' }));
    expect(vm.type).toBe('some_imported_type');
    expect(vm.typeLabel, 'must never be blank').toBeTruthy();
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

  // ── Phase 1 (DOCUMENTS-REMEDIATION-PLAN) — new non-PII fields surface in the VM
  it('9) sensitive flag surfaces as isSensitive', () => {
    expect(toDocumentViewModel(baseDoc({ sensitive: true })).isSensitive).toBe(true);
    expect(toDocumentViewModel(baseDoc({ sensitive: false })).isSensitive).toBe(false);
  });

  it('10) scanStatus + localized label + isScanClean', () => {
    const cleanHe = toDocumentViewModel(baseDoc({ scanStatus: 'clean' }), 'he');
    expect(cleanHe.scanStatus).toBe('clean');
    expect(cleanHe.isScanClean).toBe(true);
    expect(cleanHe.scanStatusLabel).toBeTruthy();

    const pendingEn = toDocumentViewModel(baseDoc({ scanStatus: 'pending' }), 'en');
    expect(pendingEn.scanStatus).toBe('pending');
    expect(pendingEn.isScanClean).toBe(false);
    expect(pendingEn.scanStatusLabel).toBe('Scanning');

    // Every scan state has a non-blank label in both locales.
    for (const s of ['pending', 'clean', 'infected', 'error'] as const) {
      expect(toDocumentViewModel(baseDoc({ scanStatus: s }), 'he').scanStatusLabel).toBeTruthy();
      expect(toDocumentViewModel(baseDoc({ scanStatus: s }), 'en').scanStatusLabel).toBeTruthy();
    }
  });

  it('11) resolved parent labels (projectName / apartmentName) surface; absent → null', () => {
    const withParents = toDocumentViewModel(
      baseDoc({ projectName: 'מתחם הרצל', apartmentName: '4' }),
    );
    expect(withParents.projectName).toBe('מתחם הרצל');
    expect(withParents.apartmentName).toBe('4');

    // A producer that didn't resolve the labels (field absent) → null in the VM.
    const noParents = toDocumentViewModel(baseDoc());
    expect(noParents.projectName).toBeNull();
    expect(noParents.apartmentName).toBeNull();
  });

  it('12) parent labels are bidi-stripped (RTL-spoof defense, like name)', () => {
    // U+202E (RLO) embedded in a parent project name must be stripped. Built via
    // fromCharCode so the source file carries no literal bidi-override codepoint.
    const RLO = String.fromCharCode(0x202e);
    const vm = toDocumentViewModel(baseDoc({ projectName: `proj${RLO}evil` }));
    expect(vm.projectName).toBe('projevil');
    expect(vm.projectName).not.toContain(RLO);
  });
});
