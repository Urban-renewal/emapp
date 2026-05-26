/**
 * Phase 4e — pin the Wire → ViewModel adapter for Note.
 *
 * Test IDs (D.33 mapping):
 *   T-4e-VM.1  basic field pass-through (body, pinned, createdBy)
 *   T-4e-VM.2  createdByShort = first 8 hex chars (no dashes)
 *   T-4e-VM.3  isArchived toggle by archivedAt
 *   T-4e-VM.4  lookup populates createdByName
 *   T-4e-VM.5  missing lookup → createdByName undefined
 *   T-4e-VM.6  toNoteViewModels — pinned notes float to top
 *   T-4e-VM.7  toNoteViewModels — stable order within pinned/un-pinned buckets
 */
import { NoteSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toNoteViewModel, toNoteViewModels } from './note';

function baseNote(over: Partial<import('@emapp/shared-types').Note> = {}) {
  return NoteSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    projectId: null,
    apartmentId: null,
    body: 'Sample note',
    pinned: false,
    createdBy: 'abcdef12-3456-4789-8abc-def012345678',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toNoteViewModel — surface', () => {
  it('T-4e-VM.1) body / pinned / createdBy pass through verbatim', () => {
    const vm = toNoteViewModel(baseNote({ body: 'X', pinned: true }));
    expect(vm.body).toBe('X');
    expect(vm.pinned).toBe(true);
    expect(vm.createdBy).toBe('abcdef12-3456-4789-8abc-def012345678');
  });

  it('T-4e-VM.2) createdByShort = first 8 hex chars (no dashes)', () => {
    const vm = toNoteViewModel(baseNote());
    expect(vm.createdByShort).toBe('abcdef12');
    expect(vm.createdByShort.length).toBe(8);
  });

  it('T-4e-VM.3) isArchived toggle by archivedAt', () => {
    expect(toNoteViewModel(baseNote({ archivedAt: new Date() })).isArchived).toBe(true);
    expect(toNoteViewModel(baseNote({ archivedAt: null })).isArchived).toBe(false);
  });
});

describe('toNoteViewModel — member lookup', () => {
  it('T-4e-VM.4) lookup populates createdByName when userId matches', () => {
    const lookup = new Map([
      ['abcdef12-3456-4789-8abc-def012345678', { name: 'Dana Cohen', email: 'dana@alpha.dev' }],
    ]);
    const vm = toNoteViewModel(baseNote(), 'he', lookup);
    expect(vm.createdByName).toBe('Dana Cohen');
  });

  it('T-4e-VM.5) no lookup → createdByName undefined (graceful degrade)', () => {
    expect(toNoteViewModel(baseNote(), 'he', undefined).createdByName).toBeUndefined();
  });
});

describe('toNoteViewModels — sort', () => {
  it('T-4e-VM.6) pinned notes float to the top of the list', () => {
    const out = toNoteViewModels([
      baseNote({ id: '11111111-1111-4111-8111-111111111111', pinned: false, body: 'A' }),
      baseNote({ id: '22222222-2222-4222-8222-222222222222', pinned: true, body: 'B' }),
      baseNote({ id: '33333333-3333-4333-8333-333333333333', pinned: false, body: 'C' }),
      baseNote({ id: '44444444-4444-4444-8444-444444444444', pinned: true, body: 'D' }),
    ]);
    expect(out.map((n) => n.body)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('T-4e-VM.7) order within each bucket (pinned / un-pinned) is preserved from input', () => {
    // BE returns rows DESC by createdAt; we mirror that order inside
    // each bucket. The test asserts stability via input-order match.
    const out = toNoteViewModels([
      baseNote({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pinned: false, body: 'older' }),
      baseNote({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', pinned: false, body: 'newer' }),
    ]);
    expect(out.map((n) => n.body)).toEqual(['older', 'newer']);
  });
});
