/**
 * AUDIT — §v9-P0-1 closure gate.
 *
 * Every SAMPLE_* must `Schema.parse()` clean. If a wire-schema field
 * changes (rename, new required field, tighter validation) and a
 * SAMPLE_* drifts → this spec fails → red CI → developer must update
 * the sample BEFORE merging.
 *
 * Doc 05 §10 + Doc 11 §2.
 */
import {
  ApartmentOwnerSchema,
  ApartmentSchema,
  BuildingSchema,
  DocumentSchema,
  ImportErrorSchema,
  ImportJobSchema,
  OwnerSchema,
  ProjectSchema,
  UserProfileSchema,
} from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { SAMPLE_APARTMENTS } from './apartments';
import { SAMPLE_BUILDINGS } from './buildings';
import { SAMPLE_DOCUMENTS } from './documents';
import { SAMPLE_IMPORT_ERRORS, SAMPLE_IMPORTS } from './imports';
import { SAMPLE_OWNERS } from './owners';
import { SAMPLE_APARTMENT_OWNERS } from './ownerships';
import { SAMPLE_PROJECTS } from './projects';
import { SAMPLE_ME, SAMPLE_USERS } from './users';

describe('SAMPLE_* — schema-parse gate (drift detector)', () => {
  it('1) SAMPLE_USERS / SAMPLE_ME parse against UserProfileSchema', () => {
    SAMPLE_USERS.forEach((u) => expect(() => UserProfileSchema.parse(u)).not.toThrow());
    expect(() => UserProfileSchema.parse(SAMPLE_ME)).not.toThrow();
  });
  it('2) SAMPLE_PROJECTS parse against ProjectSchema', () => {
    SAMPLE_PROJECTS.forEach((p) => expect(() => ProjectSchema.parse(p)).not.toThrow());
  });
  it('3) SAMPLE_BUILDINGS parse against BuildingSchema', () => {
    SAMPLE_BUILDINGS.forEach((b) => expect(() => BuildingSchema.parse(b)).not.toThrow());
  });
  it('4) SAMPLE_APARTMENTS parse against ApartmentSchema', () => {
    SAMPLE_APARTMENTS.forEach((a) => expect(() => ApartmentSchema.parse(a)).not.toThrow());
  });
  it('5) SAMPLE_OWNERS parse against OwnerSchema (masked PII only — §v9-M-4 regex)', () => {
    SAMPLE_OWNERS.forEach((o) => expect(() => OwnerSchema.parse(o)).not.toThrow());
  });
  it('6) SAMPLE_APARTMENT_OWNERS parse against ApartmentOwnerSchema', () => {
    SAMPLE_APARTMENT_OWNERS.forEach((o) =>
      expect(() => ApartmentOwnerSchema.parse(o)).not.toThrow(),
    );
  });
  it('7) SAMPLE_DOCUMENTS parse against DocumentSchema', () => {
    SAMPLE_DOCUMENTS.forEach((d) => expect(() => DocumentSchema.parse(d)).not.toThrow());
  });

  it('8) SAMPLE_IMPORTS parse against ImportJobSchema (D.34 — 8-state enum)', () => {
    SAMPLE_IMPORTS.forEach((i) => expect(() => ImportJobSchema.parse(i)).not.toThrow());
    // Spot-check that the awaiting_mapping variant is present so the
    // mapping wizard has a fixture to render against.
    expect(SAMPLE_IMPORTS.some((i) => i.status === 'awaiting_mapping')).toBe(true);
  });
  it('9) SAMPLE_IMPORT_ERRORS parse against ImportErrorSchema', () => {
    SAMPLE_IMPORT_ERRORS.forEach((e) => expect(() => ImportErrorSchema.parse(e)).not.toThrow());
  });

  it('10) SAMPLE_OWNERS pass the new MaskedPii regex (closes §v9-M-4 + §v9-P0-1)', () => {
    // The owners sample uses bullet-masked forms; if a future fixture
    // tried clear digits the regex would reject it.
    SAMPLE_OWNERS.forEach((o) => {
      expect(o.nationalIdMasked).toMatch(/[•*]/);
      if (o.phoneMasked) expect(o.phoneMasked).toMatch(/[•*]/);
    });
  });
});
