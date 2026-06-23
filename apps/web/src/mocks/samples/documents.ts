import type { Document } from '@emapp/shared-types';

export const SAMPLE_DOCUMENTS: Document[] = [
  {
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
    organizationId: '22222222-2222-2222-2222-222222222222',
    projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    apartmentId: null,
    name: 'contract-template.pdf',
    type: 'contract',
    mimeType: 'application/pdf',
    sizeBytes: 524_288,
    contentHash: 'a'.repeat(64),
    uploadedBy: '11111111-1111-1111-1111-111111111111',
    createdAt: new Date('2026-04-15T10:00:00Z'),
    updatedAt: new Date('2026-04-15T10:00:00Z'),
    archivedAt: null,
    // Phase 1 (DOCUMENTS-REMEDIATION-PLAN) — the wire shape now carries the
    // non-PII processing flags + resolved parent labels.
    sensitive: false,
    scanStatus: 'clean',
    projectName: 'מתחם הרצל 12',
    apartmentName: null,
  },
];
