import { describe, expect, it } from 'vitest';

import {
  CreateProjectInput,
  ProjectSchema,
  ProjectTypeEnum,
  RelocationTypeEnum,
  SignatureMilestoneSchema,
  SignatureMilestonesSchema,
  UpdateProjectInput,
} from './project';

/**
 * Owner-approved staged overlay (Gate-6, Option A) — milestone validation.
 * Covers the per-row schema, the array rules (ascending / unique / max-10),
 * and the cross-field `pct <= targetSignaturePct` rule on the create/update
 * bodies.
 */
describe('SignatureMilestoneSchema (per-row)', () => {
  it('accepts a valid row with optional label', () => {
    expect(SignatureMilestoneSchema.parse({ pct: 50, label: 'חצי הדרך' })).toEqual({
      pct: 50,
      label: 'חצי הדרך',
    });
    expect(SignatureMilestoneSchema.parse({ pct: 25 })).toEqual({ pct: 25 });
  });

  it('rejects pct outside 1..100, non-integer pct, and a too-long label', () => {
    expect(SignatureMilestoneSchema.safeParse({ pct: 0 }).success).toBe(false);
    expect(SignatureMilestoneSchema.safeParse({ pct: 101 }).success).toBe(false);
    expect(SignatureMilestoneSchema.safeParse({ pct: 33.5 }).success).toBe(false);
    expect(SignatureMilestoneSchema.safeParse({ pct: 50, label: 'x'.repeat(81) }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (strict / mass-assignment defence)', () => {
    expect(SignatureMilestoneSchema.safeParse({ pct: 50, weight: 2 }).success).toBe(false);
  });
});

describe('SignatureMilestonesSchema (array rules)', () => {
  it('accepts a strictly ascending list', () => {
    expect(SignatureMilestonesSchema.parse([{ pct: 25 }, { pct: 50 }, { pct: 66 }])).toHaveLength(
      3,
    );
  });

  it('accepts an empty list', () => {
    expect(SignatureMilestonesSchema.parse([])).toEqual([]);
  });

  it('rejects a non-ascending list', () => {
    expect(SignatureMilestonesSchema.safeParse([{ pct: 50 }, { pct: 25 }]).success).toBe(false);
  });

  it('rejects duplicate pcts (not strictly ascending)', () => {
    expect(SignatureMilestonesSchema.safeParse([{ pct: 50 }, { pct: 50 }]).success).toBe(false);
  });

  it('rejects more than 10 milestones', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ pct: i + 1 }));
    expect(SignatureMilestonesSchema.safeParse(eleven).success).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => ({ pct: i + 1 }));
    expect(SignatureMilestonesSchema.safeParse(ten).success).toBe(true);
  });
});

describe('CreateProjectInput — milestones vs targetSignaturePct', () => {
  const base = { name: 'מתחם א', type: 'pinui_binui' as const };

  it('accepts milestones all <= an explicit target', () => {
    const r = CreateProjectInput.safeParse({
      ...base,
      targetSignaturePct: 66,
      signatureMilestones: [{ pct: 25 }, { pct: 50 }, { pct: 66 }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a milestone that exceeds an explicit target', () => {
    const r = CreateProjectInput.safeParse({
      ...base,
      targetSignaturePct: 60,
      signatureMilestones: [{ pct: 25 }, { pct: 66 }],
    });
    expect(r.success).toBe(false);
  });

  it('allows milestones without an explicit target (BE defaults the target later)', () => {
    const r = CreateProjectInput.safeParse({
      ...base,
      signatureMilestones: [{ pct: 25 }, { pct: 50 }],
    });
    expect(r.success).toBe(true);
  });

  it('still enforces ascending order through the create body', () => {
    const r = CreateProjectInput.safeParse({
      ...base,
      signatureMilestones: [{ pct: 50 }, { pct: 25 }],
    });
    expect(r.success).toBe(false);
  });
});

describe('P3 create-form enrichment (migration 0062) — additive optional fields', () => {
  const base = { name: 'מתחם ב', type: 'pinui_binui' as const };

  it('the type enum gained an additive "other" value (legacy values preserved)', () => {
    expect(ProjectTypeEnum.options).toContain('other');
    expect(ProjectTypeEnum.options).toContain('tama38_1');
    expect(ProjectTypeEnum.options).toContain('tama38_2');
    expect(ProjectTypeEnum.options).toContain('pinui_binui');
  });

  it('RelocationTypeEnum is the closed set none|rent_comp|alt_housing', () => {
    expect([...RelocationTypeEnum.options].sort()).toEqual(
      ['alt_housing', 'none', 'rent_comp'].sort(),
    );
  });

  it('create accepts all new fields', () => {
    const r = CreateProjectInput.safeParse({
      ...base,
      developerName: 'יזם',
      developerCompanyId: '512345678',
      existingUnits: 8,
      plannedUnits: 16,
      extraAreaSqm: 25.5,
      relocationType: 'rent_comp',
      relocationNotes: 'הערה',
      block: '6638',
      parcel: '142',
      subparcel: '3',
    });
    expect(r.success).toBe(true);
  });

  it('create still works with NONE of the new fields (backward-compat)', () => {
    expect(CreateProjectInput.safeParse(base).success).toBe(true);
  });

  it('create accepts the future "other" track + typeLabel', () => {
    const r = CreateProjectInput.safeParse({
      name: 'מסלול עתידי',
      type: 'other',
      typeLabel: 'חלופת שקד',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown relocationType (closed set) + negative unit counts', () => {
    expect(CreateProjectInput.safeParse({ ...base, relocationType: 'bogus' }).success).toBe(false);
    expect(CreateProjectInput.safeParse({ ...base, existingUnits: -1 }).success).toBe(false);
  });

  it('update can clear the new fields with null', () => {
    const r = UpdateProjectInput.safeParse({
      developerName: null,
      existingUnits: null,
      relocationType: null,
      block: null,
    });
    expect(r.success).toBe(true);
  });

  it('read schema normalises omitted new fields to null (nullish transform)', () => {
    const parsed = ProjectSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      organizationId: '22222222-2222-2222-2222-222222222222',
      name: 'X',
      type: 'tama38_2',
      status: 'planning',
      description: null,
      targetSignaturePct: null,
      startedAt: null,
      createdBy: '33333333-3333-3333-3333-333333333333',
      createdAt: new Date('2026-05-20T10:00:00Z'),
      updatedAt: new Date('2026-05-20T10:00:00Z'),
      archivedAt: null,
    });
    expect(parsed.developerName).toBeNull();
    expect(parsed.existingUnits).toBeNull();
    expect(parsed.relocationType).toBeNull();
    expect(parsed.block).toBeNull();
    expect(parsed.typeLabel).toBeNull();
  });
});

describe('UpdateProjectInput — milestones', () => {
  it('accepts clearing milestones with null', () => {
    expect(UpdateProjectInput.safeParse({ signatureMilestones: null }).success).toBe(true);
  });

  it('enforces the <= target cross-check on update too', () => {
    const r = UpdateProjectInput.safeParse({
      targetSignaturePct: 40,
      signatureMilestones: [{ pct: 50 }],
    });
    expect(r.success).toBe(false);
  });
});
