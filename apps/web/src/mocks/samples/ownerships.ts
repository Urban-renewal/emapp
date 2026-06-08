import type { ApartmentOwner } from '@emapp/shared-types';

/** SAMPLE_APARTMENT_OWNERS — what `GET /apartments/:id/owners` returns. */
export const SAMPLE_APARTMENT_OWNERS: ApartmentOwner[] = [
  {
    id: 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'דנה כהן',
    email: 'dana@example.dev',
    nationalIdMasked: '•••••••11',
    phoneMasked: '•••••4567',
    notes: null,
    createdAt: new Date('2026-04-02T10:00:00Z'),
    updatedAt: new Date('2026-04-02T10:00:00Z'),
    archivedAt: null,
    ownershipId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
    ownershipPct: 50,
    relationship: 'owner',
    role: null,
  },
  {
    id: 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'יוסי לוי',
    email: null,
    nationalIdMasked: '•••••••22',
    phoneMasked: '•••••6543',
    notes: null,
    createdAt: new Date('2026-04-02T10:00:00Z'),
    updatedAt: new Date('2026-04-02T10:00:00Z'),
    archivedAt: null,
    ownershipId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
    ownershipPct: 50,
    relationship: 'owner',
    role: null,
  },
];
