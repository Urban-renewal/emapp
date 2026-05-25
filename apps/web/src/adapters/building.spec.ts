/**
 * Phase 4a S3 — pin the Wire → ViewModel adapter for Building.
 *
 * Coverage axes (per the "make it fall" testing mandate):
 *  - addressLine composition (with/without city)
 *  - parcelSummary nullability (all-null vs partial vs full)
 *  - locale-aware parcelSummary labels (HE vs EN)
 *  - aptCount=0 surfaces as 0 (legal — empty building pending survey)
 *  - archivedAt null/Date toggles isArchived
 */
import { BuildingSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toBuildingViewModel, toBuildingViewModels } from './building';

function baseBuilding(over: Partial<import('@emapp/shared-types').Building> = {}) {
  return BuildingSchema.parse({
    id: '11111111-1111-1111-1111-111111111111',
    projectId: '22222222-2222-2222-2222-222222222222',
    address: 'הרצל 10',
    city: 'תל אביב',
    block: null,
    parcel: null,
    subparcel: null,
    aptCount: 4,
    notes: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toBuildingViewModel', () => {
  it('1) addressLine composes address + city', () => {
    const vm = toBuildingViewModel(baseBuilding());
    expect(vm.addressLine).toBe('הרצל 10, תל אביב');
  });

  it('2) parcelSummary is null when block/parcel/subparcel all null', () => {
    const vm = toBuildingViewModel(baseBuilding());
    expect(vm.parcelSummary).toBe(null);
  });

  it('3) parcelSummary lists only present components (HE labels)', () => {
    const vm = toBuildingViewModel(baseBuilding({ block: '6638', parcel: '12' }));
    expect(vm.parcelSummary).toBe('גוש 6638 · חלקה 12');
  });

  it('4) parcelSummary uses EN labels when locale=en', () => {
    const vm = toBuildingViewModel(
      baseBuilding({ block: '6638', parcel: '12', subparcel: '4' }),
      'en',
    );
    expect(vm.parcelSummary).toBe('Block 6638 · Parcel 12 · Sub-parcel 4');
  });

  it('5) aptCount=0 surfaces as 0 (legal pending state)', () => {
    expect(toBuildingViewModel(baseBuilding({ aptCount: 0 })).aptCount).toBe(0);
  });

  it('6) archivedAt=Date → isArchived=true; null → false', () => {
    expect(toBuildingViewModel(baseBuilding({ archivedAt: null })).isArchived).toBe(false);
    expect(
      toBuildingViewModel(baseBuilding({ archivedAt: new Date('2026-05-22T00:00:00Z') }))
        .isArchived,
    ).toBe(true);
  });

  it('7) toBuildingViewModels preserves order and length', () => {
    const arr = toBuildingViewModels([
      baseBuilding({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', address: 'A' }),
      baseBuilding({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', address: 'B' }),
    ]);
    expect(arr.map((b) => b.address)).toEqual(['A', 'B']);
  });

  it('8) notes null surfaces as null; notes "X" passes through', () => {
    expect(toBuildingViewModel(baseBuilding({ notes: null })).notes).toBe(null);
    expect(toBuildingViewModel(baseBuilding({ notes: 'X' })).notes).toBe('X');
  });
});
