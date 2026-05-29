import type { ProjectListItem } from '@emapp/shared-types';

// list() + get() return ProjectListItem (Project + aggregate stats). MSW
// samples must carry the stats fields or the FE's ProjectListItemSchema
// parse fails at runtime (dev/e2e), even though they're typed Project elsewhere.
export const SAMPLE_PROJECTS: ProjectListItem[] = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'Tama 38/2 — Pilot',
    type: 'tama38_2',
    status: 'gathering_signatures',
    description: 'Dev pilot project — Mock data, not real customers.',
    targetSignaturePct: 80,
    startedAt: new Date('2026-04-01T00:00:00Z'),
    createdBy: '11111111-1111-1111-1111-111111111111',
    createdAt: new Date('2026-04-01T10:00:00Z'),
    updatedAt: new Date('2026-04-15T10:00:00Z'),
    archivedAt: null,
    buildingsCount: 2,
    unitsCount: 8,
    signaturesPendingCount: 3,
    signaturesSignedCount: 5,
    agentsCount: 1,
  },
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'פינוי-בינוי הרצליה',
    type: 'pinui_binui',
    status: 'planning',
    description: null,
    targetSignaturePct: null,
    startedAt: null,
    createdBy: '11111111-1111-1111-1111-111111111111',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    buildingsCount: 0,
    unitsCount: 0,
    signaturesPendingCount: 0,
    signaturesSignedCount: 0,
    agentsCount: 0,
  },
];
