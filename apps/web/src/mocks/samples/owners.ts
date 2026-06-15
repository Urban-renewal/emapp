import type { OwnerListItem } from '@emapp/shared-types';

/**
 * SAMPLE_OWNERS — masked PII only (cleartext NEVER on the wire). Typed as
 * OwnerListItem so the offline `GET /owners` handler satisfies the list
 * contract (apartmentCount + pendingSignatureCount). The detail/search
 * handlers reuse these rows as plain Owner — the extra count fields are
 * stripped by the non-strict OwnerSchema parse on that path.
 */
export const SAMPLE_OWNERS: OwnerListItem[] = [
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
    apartmentCount: 2,
    pendingSignatureCount: 1,
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
    apartmentCount: 1,
    pendingSignatureCount: 0,
  },
];
