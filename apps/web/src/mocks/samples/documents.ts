import type { Document } from '@emapp/shared-types';

/**
 * Offline document fixtures. Spread across several PARTIES (via their `type`)
 * and a couple of projects so the PARTY-BINDER board, the project board, the
 * server search and the per-party zoom-in all have data to render offline
 * (DOCUMENTS-REMEDIATION-PLAN Phase 2a). All NON-PII.
 */
const ORG = '22222222-2222-2222-2222-222222222222';
const PROJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const PROJECT_B = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
const UPLOADER = '11111111-1111-1111-1111-111111111111';

function doc(over: Partial<Document> & Pick<Document, 'id' | 'name' | 'type'>): Document {
  return {
    organizationId: ORG,
    projectId: PROJECT_A,
    apartmentId: null,
    mimeType: 'application/pdf',
    sizeBytes: 524_288,
    contentHash: 'a'.repeat(64),
    uploadedBy: UPLOADER,
    createdAt: new Date('2026-04-15T10:00:00Z'),
    updatedAt: new Date('2026-04-15T10:00:00Z'),
    archivedAt: null,
    sensitive: false,
    scanStatus: 'clean',
    projectName: 'מתחם הרצל 12',
    apartmentName: null,
    ...over,
  };
}

export const SAMPLE_DOCUMENTS: Document[] = [
  // contractor (agreement)
  doc({
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
    name: 'contract-template.pdf',
    type: 'contract',
    createdAt: new Date('2026-04-15T10:00:00Z'),
  }),
  doc({
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff2',
    name: 'הסכם-רוב-80.pdf',
    type: 'agreement',
    createdAt: new Date('2026-05-02T09:00:00Z'),
  }),
  // owner (land_registry, sensitive)
  doc({
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff3',
    name: 'נסח-טאבו-הרצל-12.pdf',
    type: 'land_registry',
    sensitive: true,
    createdAt: new Date('2026-05-10T08:00:00Z'),
  }),
  // architect (blueprint)
  doc({
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff4',
    name: 'blueprint-floor-3.pdf',
    type: 'blueprint',
    projectId: PROJECT_B,
    projectName: 'רוטשילד 8',
    createdAt: new Date('2026-05-12T11:00:00Z'),
  }),
  // appraiser (survey) — still scanning, to exercise the scan badge
  doc({
    id: 'ffffffff-ffff-ffff-ffff-fffffffffff5',
    name: 'שומת-שמאי.pdf',
    type: 'survey',
    scanStatus: 'pending',
    createdAt: new Date('2026-05-14T12:00:00Z'),
  }),
];
