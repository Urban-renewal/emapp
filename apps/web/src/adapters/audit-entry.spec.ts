/**
 * Phase 4c S4 — pin the Wire → ViewModel adapter for AuditEntry.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S4-VM.1   splits action `import.created` → category + suffix
 *   T-4c-S4-VM.2   maps known categories to HE/EN labels
 *   T-4c-S4-VM.3   unknown category falls back to raw prefix
 *   T-4c-S4-VM.4   action without `.` → category = full string, suffix = ''
 *   T-4c-S4-VM.5   AuditActorType labels are exhaustive (HE + EN)
 *   T-4c-S4-VM.6   nullable wire fields (actorId, actorEmail,
 *                  targetTable, targetId) pass through verbatim
 *   T-4c-S4-VM.7   HE/EN locale switching
 *   T-4c-S4-VM.8   toAuditEntryViewModels preserves order
 */
import { AuditActorTypeEnum, AuditEntrySchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTOR_TYPE_LABELS_EN,
  AUDIT_ACTOR_TYPE_LABELS_HE,
  toAuditEntryViewModel,
  toAuditEntryViewModels,
} from './audit-entry';

function baseEntry(over: Partial<import('@emapp/shared-types').AuditEntry> = {}) {
  return AuditEntrySchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    actorId: '33333333-3333-4333-8333-333333333333',
    actorType: 'user',
    actorEmail: 'manager@alpha.dev',
    action: 'import.created',
    targetTable: 'import_jobs',
    targetId: '44444444-4444-4444-8444-444444444444',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    ...over,
  });
}

describe('toAuditEntryViewModel — action splitting', () => {
  it('T-4c-S4-VM.1) `import.created` splits to category=import + suffix=created', () => {
    const vm = toAuditEntryViewModel(baseEntry({ action: 'import.created' }));
    expect(vm.category).toBe('import');
    expect(vm.actionSuffix).toBe('created');
    expect(vm.action).toBe('import.created');
  });

  it('T-4c-S4-VM.1b) `member.role_change` splits to category=member + suffix=role_change', () => {
    const vm = toAuditEntryViewModel(baseEntry({ action: 'member.role_change' }));
    expect(vm.category).toBe('member');
    expect(vm.actionSuffix).toBe('role_change');
  });

  it('T-4c-S4-VM.1c) multi-dot suffix preserved verbatim (e.g. `import.bytes_purged.retry`)', () => {
    const vm = toAuditEntryViewModel(baseEntry({ action: 'import.bytes_purged.retry' }));
    expect(vm.category).toBe('import');
    expect(vm.actionSuffix).toBe('bytes_purged.retry');
  });

  it('T-4c-S4-VM.4) action without `.` → category=full, suffix=""', () => {
    const vm = toAuditEntryViewModel(baseEntry({ action: 'standalone' }));
    expect(vm.category).toBe('standalone');
    expect(vm.actionSuffix).toBe('');
  });
});

describe('toAuditEntryViewModel — category labels', () => {
  it('T-4c-S4-VM.2) HE label for `import` is "ייבוא"', () => {
    expect(toAuditEntryViewModel(baseEntry({ action: 'import.x' }), 'he').categoryLabel).toBe(
      'ייבוא',
    );
  });

  it('T-4c-S4-VM.2b) EN label for `import` is "Imports"', () => {
    expect(toAuditEntryViewModel(baseEntry({ action: 'import.x' }), 'en').categoryLabel).toBe(
      'Imports',
    );
  });

  it('T-4c-S4-VM.3) unknown category falls back to raw prefix (forensic visibility)', () => {
    const vm = toAuditEntryViewModel(baseEntry({ action: 'futurething.x' }), 'he');
    expect(vm.categoryLabel).toBe('futurething');
  });
});

describe('toAuditEntryViewModel — actor + nullable fields', () => {
  it('T-4c-S4-VM.5) actorType labels are exhaustive over AuditActorTypeEnum', () => {
    const enumKeys = [...AuditActorTypeEnum.options].sort();
    expect(Object.keys(AUDIT_ACTOR_TYPE_LABELS_HE).sort()).toEqual(enumKeys);
    expect(Object.keys(AUDIT_ACTOR_TYPE_LABELS_EN).sort()).toEqual(enumKeys);
  });

  it('T-4c-S4-VM.5b) system actorType renders the right label per locale', () => {
    expect(toAuditEntryViewModel(baseEntry({ actorType: 'system' }), 'he').actorTypeLabel).toBe(
      'מערכת',
    );
    expect(toAuditEntryViewModel(baseEntry({ actorType: 'system' }), 'en').actorTypeLabel).toBe(
      'System',
    );
  });

  it('T-4c-S4-VM.6) nullable fields pass through verbatim', () => {
    const vm = toAuditEntryViewModel(
      baseEntry({ actorId: null, actorEmail: null, targetTable: null, targetId: null }),
    );
    expect(vm.actorId).toBe(null);
    expect(vm.actorEmail).toBe(null);
    expect(vm.targetTable).toBe(null);
    expect(vm.targetId).toBe(null);
  });
});

describe('toAuditEntryViewModel — surface', () => {
  it('T-4c-S4-VM.7) HE / EN locale switching changes both category + actorType labels', () => {
    const he = toAuditEntryViewModel(baseEntry(), 'he');
    const en = toAuditEntryViewModel(baseEntry(), 'en');
    expect(he.categoryLabel).not.toBe(en.categoryLabel);
    expect(he.actorTypeLabel).not.toBe(en.actorTypeLabel);
  });

  it('T-4c-S4-VM.8) toAuditEntryViewModels preserves order', () => {
    const arr = toAuditEntryViewModels([
      baseEntry({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'import.created' }),
      baseEntry({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', action: 'member.invite' }),
    ]);
    expect(arr.map((e) => e.action)).toEqual(['import.created', 'member.invite']);
  });

  it('T-4c-S4-VM.8b) createdAtIso is canonical ISO', () => {
    expect(toAuditEntryViewModel(baseEntry()).createdAtIso).toBe('2026-05-20T10:00:00.000Z');
  });
});

// ── Phase 4g — suffix dictionary (closes the 4c "raw + category"
//    deferral with a curated HE/EN verb map). ──
describe('toAuditEntryViewModel — Phase 4g suffix dictionary', () => {
  it('T-4g-VM.1) universal verb: `xxx.create` → "נוצר" / "Created"', () => {
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'project.create' }), 'he').actionSuffixLabel,
    ).toBe('נוצר');
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'project.create' }), 'en').actionSuffixLabel,
    ).toBe('Created');
  });

  it('T-4g-VM.2) universal verb works for any category — `task.archive`', () => {
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'task.archive' }), 'he').actionSuffixLabel,
    ).toBe('אורכב');
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'task.archive' }), 'en').actionSuffixLabel,
    ).toBe('Archived');
  });

  it('T-4g-VM.3) category override wins over universal — `import.received`', () => {
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'import.received' }), 'he').actionSuffixLabel,
    ).toBe('התקבל');
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'import.received' }), 'en').actionSuffixLabel,
    ).toBe('Received');
  });

  it('T-4g-VM.4) unknown suffix in a known category → raw fallback', () => {
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'import.brand_new_event' })).actionSuffixLabel,
    ).toBe('brand_new_event');
  });

  it('T-4g-VM.5) unknown suffix in an unknown category → raw fallback', () => {
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'futurething.something' })).actionSuffixLabel,
    ).toBe('something');
  });

  it('T-4g-VM.6) no suffix → empty label', () => {
    expect(toAuditEntryViewModel(baseEntry({ action: 'standalone' })).actionSuffixLabel).toBe('');
  });

  it('T-4g-VM.7) `member.role_change` → "תפקיד שונה" / "Role changed"', () => {
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'member.role_change' }), 'he').actionSuffixLabel,
    ).toBe('תפקיד שונה');
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'member.role_change' }), 'en').actionSuffixLabel,
    ).toBe('Role changed');
  });

  it('T-4g-VM.8) `signature_request.cancel` override ≠ universal `cancelled`', () => {
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'signature_request.cancel' }), 'he')
        .actionSuffixLabel,
    ).toBe('בקשה בוטלה');
    expect(
      toAuditEntryViewModel(baseEntry({ action: 'signature_request.cancel' }), 'en')
        .actionSuffixLabel,
    ).toBe('Request cancelled');
  });

  it('T-4g-VM.9) raw `actionSuffix` stays available alongside the curated label', () => {
    const vm = toAuditEntryViewModel(baseEntry({ action: 'import.received' }));
    expect(vm.actionSuffix).toBe('received'); // raw — for forensic grep
    expect(vm.actionSuffixLabel).toBe('התקבל'); // curated — for UI
  });
});
