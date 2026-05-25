/**
 * Phase 4a S4 — pin the Wire → ViewModel adapter for Apartment.
 *
 * Coverage: every apartment_status enum member labeled + color-coded;
 * facts line composes only present fields; isArchived toggle.
 */
import { ApartmentSchema, ApartmentStatusEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  APARTMENT_STATUS_COLORS,
  APARTMENT_STATUS_LABELS_EN,
  APARTMENT_STATUS_LABELS_HE,
  toApartmentViewModel,
  toApartmentViewModels,
} from './apartment';

function baseApt(over: Partial<import('@emapp/shared-types').Apartment> = {}) {
  return ApartmentSchema.parse({
    id: '11111111-1111-1111-1111-111111111111',
    buildingId: '22222222-2222-2222-2222-222222222222',
    number: '3',
    floor: 2,
    sizeSqm: 85,
    rooms: 3.5,
    status: 'pending',
    statusChangedAt: new Date('2026-05-20T10:00:00Z'),
    lastContactAt: null,
    notes: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toApartmentViewModel', () => {
  it('1) HE labels cover every apartment_status enum value (no drift)', () => {
    const k = Object.keys(APARTMENT_STATUS_LABELS_HE).sort();
    expect(k).toEqual([...ApartmentStatusEnum.options].sort());
  });

  it('2) EN labels cover every apartment_status enum value', () => {
    const k = Object.keys(APARTMENT_STATUS_LABELS_EN).sort();
    expect(k).toEqual([...ApartmentStatusEnum.options].sort());
  });

  it('3) colors cover every status; only the locked 4 palette tokens', () => {
    const k = Object.keys(APARTMENT_STATUS_COLORS).sort();
    expect(k).toEqual([...ApartmentStatusEnum.options].sort());
    for (const status of ApartmentStatusEnum.options) {
      expect(['gray', 'amber', 'emerald', 'red']).toContain(APARTMENT_STATUS_COLORS[status]);
    }
  });

  it('4) factsLine composes floor + rooms + sqm with HE labels', () => {
    expect(toApartmentViewModel(baseApt()).factsLine).toBe('קומה 2 · 3.5 חדרים · 85 מ"ר');
  });

  it('5) factsLine omits null fields', () => {
    expect(toApartmentViewModel(baseApt({ floor: null, sizeSqm: null })).factsLine).toBe(
      '3.5 חדרים',
    );
    expect(
      toApartmentViewModel(baseApt({ floor: null, rooms: null, sizeSqm: null })).factsLine,
    ).toBe('');
  });

  it('6) factsLine uses EN labels when locale=en', () => {
    expect(toApartmentViewModel(baseApt(), 'en').factsLine).toBe('Floor 2 · 3.5 rooms · 85 m²');
  });

  it('7) isArchived true when archivedAt present', () => {
    expect(
      toApartmentViewModel(baseApt({ archivedAt: new Date('2026-05-22T00:00:00Z') })).isArchived,
    ).toBe(true);
  });

  it('8) status pass-through + label/color from the active locale', () => {
    const signedHe = toApartmentViewModel(baseApt({ status: 'signed' }));
    expect(signedHe.status).toBe('signed');
    expect(signedHe.statusLabel).toBe('חתום');
    expect(signedHe.statusColor).toBe('emerald');

    const refusedEn = toApartmentViewModel(baseApt({ status: 'refused' }), 'en');
    expect(refusedEn.statusLabel).toBe('Refused');
    expect(refusedEn.statusColor).toBe('red');
  });

  it('9) toApartmentViewModels preserves order', () => {
    const arr = toApartmentViewModels([
      baseApt({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', number: 'A' }),
      baseApt({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', number: 'B' }),
    ]);
    expect(arr.map((a) => a.number)).toEqual(['A', 'B']);
  });
});
