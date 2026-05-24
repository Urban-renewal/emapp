import type { Building } from '@emapp/shared-types';

export const SAMPLE_BUILDINGS: Building[] = [
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    address: 'הרצל 10',
    city: 'תל אביב',
    block: '6638',
    parcel: '12',
    subparcel: '4',
    aptCount: 8,
    notes: null,
    createdAt: new Date('2026-04-02T10:00:00Z'),
    updatedAt: new Date('2026-04-02T10:00:00Z'),
    archivedAt: null,
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
    projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    address: 'בן יהודה 25',
    city: 'תל אביב',
    block: null,
    parcel: null,
    subparcel: null,
    aptCount: 6,
    notes: null,
    createdAt: new Date('2026-04-03T10:00:00Z'),
    updatedAt: new Date('2026-04-03T10:00:00Z'),
    archivedAt: null,
  },
];
