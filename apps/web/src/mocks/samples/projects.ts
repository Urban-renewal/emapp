import type { Project } from '@emapp/shared-types';

export const SAMPLE_PROJECTS: Project[] = [
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
  },
];
