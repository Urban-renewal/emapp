import type { Apartment } from '@emapp/shared-types';

export const SAMPLE_APARTMENTS: Apartment[] = [
  {
    id: 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    buildingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    number: '1',
    floor: 1,
    sizeSqm: 85,
    rooms: 3.5,
    status: 'pending',
    statusChangedAt: new Date('2026-04-02T10:00:00Z'),
    lastContactAt: null,
    notes: null,
    createdAt: new Date('2026-04-02T10:00:00Z'),
    updatedAt: new Date('2026-04-02T10:00:00Z'),
    archivedAt: null,
  },
  {
    id: 'cccccccc-cccc-cccc-cccc-ccccccccccc2',
    buildingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    number: '2',
    floor: 1,
    sizeSqm: 92,
    rooms: 4,
    status: 'contacted',
    statusChangedAt: new Date('2026-04-10T10:00:00Z'),
    lastContactAt: new Date('2026-04-10T10:00:00Z'),
    notes: null,
    createdAt: new Date('2026-04-02T10:00:00Z'),
    updatedAt: new Date('2026-04-10T10:00:00Z'),
    archivedAt: null,
  },
];
