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
  ApartmentHoldoutSchema,
  ApartmentOwnerSchema,
  ApartmentSchema,
  ApartmentSignatureProgressSchema,
  BuildingSchema,
  ContractorSchema,
  DocumentSchema,
  ImportErrorSchema,
  ImportJobSchema,
  NotificationSchema,
  OwnerListItemSchema,
  OwnerSchema,
  ProjectSchema,
  SignatureDeliveryReportSchema,
  SignatureProgressSchema,
  SignaturePulseSchema,
  SignatureRequestSchema,
  UserProfileSchema,
} from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { SAMPLE_APARTMENTS } from './apartments';
import { SAMPLE_BUILDINGS } from './buildings';
import { SAMPLE_CONTRACTORS, SAMPLE_CONTRACTOR_SPECIALTIES } from './contractors';
import { SAMPLE_DOCUMENTS } from './documents';
import { SAMPLE_IMPORT_ERRORS, SAMPLE_IMPORTS } from './imports';
import { SAMPLE_NOTIFICATIONS, SAMPLE_NOTIFICATIONS_UNREAD_COUNT } from './notifications';
import { SAMPLE_OWNERS } from './owners';
import { SAMPLE_APARTMENT_OWNERS } from './ownerships';
import { SAMPLE_PROJECTS } from './projects';
import {
  SAMPLE_APARTMENT_HOLDOUTS,
  SAMPLE_APARTMENT_SIGNATURE_PROGRESS,
  SAMPLE_SIGNATURE_PROGRESS,
} from './signature-progress';
import { SAMPLE_SIGNATURE_PULSE, SAMPLE_SIGNATURE_PULSE_ALL_CLEAR } from './signature-pulse';
import { SAMPLE_SIGNATURE_DELIVERY, SAMPLE_SIGNATURE_REQUESTS } from './signature-requests';
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
  it('5b) SAMPLE_OWNERS satisfy OwnerListItemSchema (the offline GET /owners list contract)', () => {
    // The MSW `GET /owners` handler returns SAMPLE_OWNERS, and the FE parses
    // list items with OwnerListItemSchema — so the sample MUST carry the two
    // aggregate counts or offline mode would throw on the owners page.
    SAMPLE_OWNERS.forEach((o) => expect(() => OwnerListItemSchema.parse(o)).not.toThrow());
  });
  it('6) SAMPLE_APARTMENT_OWNERS parse against ApartmentOwnerSchema', () => {
    SAMPLE_APARTMENT_OWNERS.forEach((o) =>
      expect(() => ApartmentOwnerSchema.parse(o)).not.toThrow(),
    );
  });
  it('7) SAMPLE_DOCUMENTS parse against DocumentSchema', () => {
    SAMPLE_DOCUMENTS.forEach((d) => expect(() => DocumentSchema.parse(d)).not.toThrow());
  });
  it('7b) SAMPLE_CONTRACTORS parse against ContractorSchema + facet is DISTINCT/derived', () => {
    SAMPLE_CONTRACTORS.forEach((c) => expect(() => ContractorSchema.parse(c)).not.toThrow());
    // The data-derived specialty facet must be the DISTINCT non-null specialties
    // of the sample (so the offline chips match what the BE would compute), and
    // varied enough that the filter is meaningfully exercisable offline.
    const expected = Array.from(
      new Set(SAMPLE_CONTRACTORS.map((c) => c.specialty).filter((s): s is string => s !== null)),
    );
    expect([...SAMPLE_CONTRACTOR_SPECIALTIES].sort()).toEqual([...expected].sort());
    expect(SAMPLE_CONTRACTOR_SPECIALTIES.length).toBeGreaterThan(1);
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

  it('10) SAMPLE_SIGNATURE_REQUESTS parse against SignatureRequestSchema (D.12 3-state)', () => {
    SAMPLE_SIGNATURE_REQUESTS.forEach((r) =>
      expect(() => SignatureRequestSchema.parse(r)).not.toThrow(),
    );
    // Spot-check all three states are present so the manager UI has
    // pending/signed/cancelled fixtures to render against.
    const statuses = SAMPLE_SIGNATURE_REQUESTS.map((r) => r.status).sort();
    expect(statuses).toEqual(['cancelled', 'pending', 'signed']);
  });
  it('11) SAMPLE_SIGNATURE_DELIVERY parses against SignatureDeliveryReportSchema', () => {
    expect(() => SignatureDeliveryReportSchema.parse(SAMPLE_SIGNATURE_DELIVERY)).not.toThrow();
  });
  it('12) SAMPLE_SIGNATURE_REQUESTS never carry a `jti` or raw JWT (D.12 security invariant)', () => {
    SAMPLE_SIGNATURE_REQUESTS.forEach((r) => {
      expect(r).not.toHaveProperty('jti');
      expect(r).not.toHaveProperty('token');
    });
  });

  it('14) SAMPLE_SIGNATURE_PROGRESS parses against SignatureProgressSchema (E2.2-S3 board)', () => {
    expect(() => SignatureProgressSchema.parse(SAMPLE_SIGNATURE_PROGRESS)).not.toThrow();
  });
  it('15) SAMPLE_APARTMENT_SIGNATURE_PROGRESS parse against ApartmentSignatureProgressSchema', () => {
    SAMPLE_APARTMENT_SIGNATURE_PROGRESS.forEach((a) =>
      expect(() => ApartmentSignatureProgressSchema.parse(a)).not.toThrow(),
    );
    // A `partial` row must exist so the offline "who's stuck" reveal has a target.
    expect(SAMPLE_APARTMENT_SIGNATURE_PROGRESS.some((a) => a.status === 'partial')).toBe(true);
  });
  it('16) SAMPLE_APARTMENT_HOLDOUTS parse against ApartmentHoldoutSchema (B4 — name only, no national_id/phone)', () => {
    SAMPLE_APARTMENT_HOLDOUTS.forEach((h) => {
      expect(() => ApartmentHoldoutSchema.parse(h)).not.toThrow();
      // B4 security invariant — the holdout shape carries the NAME only; the
      // other PII fields must NEVER appear on this wire surface.
      expect(h).not.toHaveProperty('national_id');
      expect(h).not.toHaveProperty('nationalId');
      expect(h).not.toHaveProperty('phone');
    });
  });
  it('17) SAMPLE_SIGNATURE_PULSE (+ all-clear) parse against SignaturePulseSchema (E2.1)', () => {
    expect(() => SignaturePulseSchema.parse(SAMPLE_SIGNATURE_PULSE)).not.toThrow();
    expect(() => SignaturePulseSchema.parse(SAMPLE_SIGNATURE_PULSE_ALL_CLEAR)).not.toThrow();
    // The attention feed must be NON-empty in the default fixture so the
    // offline home renders ActionCards (not the empty-state).
    expect(SAMPLE_SIGNATURE_PULSE.attention.length).toBeGreaterThan(0);
    // All-clear fixture must be empty so it drives the reward empty-state.
    expect(SAMPLE_SIGNATURE_PULSE_ALL_CLEAR.attention).toHaveLength(0);
  });

  it('18) SAMPLE_NOTIFICATIONS parse against NotificationSchema (bell + page offline)', () => {
    SAMPLE_NOTIFICATIONS.forEach((n) => expect(() => NotificationSchema.parse(n)).not.toThrow());
    // Authored at scale — spans >1 keyset page (25) so "load more" accumulates.
    expect(SAMPLE_NOTIFICATIONS.length).toBeGreaterThan(25);
    // The true unread total must EXCEED the legacy bell "5+" page-local cap so the
    // offline bell badge proves it shows the real number, not a 5-row count.
    expect(SAMPLE_NOTIFICATIONS_UNREAD_COUNT).toBeGreaterThan(5);
    // No PII leaks onto the notification wire (title/body are doc/apt/task only).
    SAMPLE_NOTIFICATIONS.forEach((n) => {
      expect(n).not.toHaveProperty('national_id');
      expect(n).not.toHaveProperty('phone');
    });
  });

  it('13) SAMPLE_OWNERS pass the new MaskedPii regex (closes §v9-M-4 + §v9-P0-1)', () => {
    // The owners sample uses bullet-masked forms; if a future fixture
    // tried clear digits the regex would reject it.
    SAMPLE_OWNERS.forEach((o) => {
      expect(o.nationalIdMasked).toMatch(/[•*]/);
      if (o.phoneMasked) expect(o.phoneMasked).toMatch(/[•*]/);
    });
  });
});
