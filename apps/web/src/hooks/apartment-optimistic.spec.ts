import type { Apartment } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import type { ApartmentListPage } from '@/lib/api/apartments';

import { applyApartmentStatus } from './apartment-optimistic';

const AT = new Date('2026-06-14T12:00:00.000Z');
const OLD = new Date('2026-06-01T00:00:00.000Z');

function apt(id: string, status: Apartment['status']): Apartment {
  return {
    id,
    buildingId: 'b1',
    number: '1',
    floor: null,
    sizeSqm: null,
    rooms: null,
    status,
    statusChangedAt: OLD,
    lastContactAt: null,
    notes: null,
    unitType: 'apt',
    areaSqm: null,
    entrance: null,
    createdAt: OLD,
    updatedAt: OLD,
    archivedAt: null,
  } as Apartment;
}

function page(items: Apartment[]): ApartmentListPage {
  return { items, page: { limit: 25, cursor: null, has_more: false } };
}

describe('applyApartmentStatus — optimistic transform (both cache shapes)', () => {
  it('patches status + statusChangedAt on the matching DETAIL record', () => {
    const before = apt('a', 'pending');
    const after = applyApartmentStatus(before, 'a', 'contacted', AT) as Apartment;
    expect(after.status).toBe('contacted');
    expect(after.statusChangedAt).toEqual(AT);
  });

  it('leaves a non-matching detail record untouched (same reference)', () => {
    const before = apt('a', 'pending');
    const after = applyApartmentStatus(before, 'other', 'contacted', AT);
    expect(after).toBe(before);
  });

  it('patches only the matching apartment inside a LIST page', () => {
    const before = page([apt('a', 'pending'), apt('b', 'signed')]);
    const after = applyApartmentStatus(before, 'a', 'meeting', AT) as ApartmentListPage;
    expect(after.items.find((x) => x.id === 'a')?.status).toBe('meeting');
    expect(after.items.find((x) => x.id === 'b')?.status).toBe('signed');
  });

  it('does not mutate the input (detail or list) in place', () => {
    const detail = apt('a', 'pending');
    applyApartmentStatus(detail, 'a', 'contacted', AT);
    expect(detail.status).toBe('pending'); // original untouched

    const list = page([apt('a', 'pending')]);
    const firstRef = list.items[0];
    applyApartmentStatus(list, 'a', 'contacted', AT);
    expect(list.items[0]).toBe(firstRef);
    expect(list.items[0]?.status).toBe('pending');
  });

  it('returns undefined input unchanged (no cache entry yet)', () => {
    expect(applyApartmentStatus(undefined, 'a', 'contacted', AT)).toBeUndefined();
  });
});
