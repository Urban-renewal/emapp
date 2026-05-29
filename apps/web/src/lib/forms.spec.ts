import { CreateContractorInput, CreateOwnerInput, CreateTaskInput } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { emptyToUndefined } from './forms';

/**
 * §FUNC-1 — the empty-string class bug + its form-boundary fix.
 *
 * These are MECHANISM tests (D.51): they assert the exact Zod behavior
 * that makes a blank optional+formatted field unsubmittable, and prove
 * `emptyToUndefined` neutralizes it at the form boundary WITHOUT loosening
 * the wire contract. A plaster (e.g. swallowing the resolver error) could
 * not make `CreateOwnerInput.safeParse` accept the transformed payload —
 * only correctly omitting the blank field does.
 */
describe('emptyToUndefined (form-boundary setValueAs)', () => {
  it("maps '' → undefined", () => {
    expect(emptyToUndefined('')).toBeUndefined();
  });

  it('passes through a real value unchanged', () => {
    expect(emptyToUndefined('dana@example.test')).toBe('dana@example.test');
    expect(emptyToUndefined('0501234567')).toBe('0501234567');
  });

  it('does not coerce null or non-empty whitespace (only the empty string)', () => {
    expect(emptyToUndefined(null)).toBeNull();
    expect(emptyToUndefined('   ')).toBe('   ');
  });
});

describe('§FUNC-1 owner-create — blank optional formatted fields', () => {
  const requiredOnly = { name: 'דנה כהן', national_id: '999000441' } as const;

  it('reproduces the bug: raw empty strings are REJECTED by the schema', () => {
    // This is exactly what `register('email')` / `register('phone')` submit
    // for untouched inputs before the fix. The form became unsubmittable.
    const raw = { ...requiredOnly, email: '', phone: '' };
    const parsed = CreateOwnerInput.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('email');
      expect(fields).toContain('phone');
    }
  });

  it('the fix: emptyToUndefined-transformed blanks parse cleanly (fields omitted)', () => {
    const transformed = {
      ...requiredOnly,
      email: emptyToUndefined(''),
      phone: emptyToUndefined(''),
    };
    const parsed = CreateOwnerInput.safeParse(transformed);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The wire body OMITS the blank optionals — it does NOT send ''.
      expect(parsed.data.email).toBeUndefined();
      expect(parsed.data.phone).toBeUndefined();
    }
  });

  it('a real value still flows through the same transform', () => {
    const parsed = CreateOwnerInput.safeParse({
      ...requiredOnly,
      email: emptyToUndefined('dana@example.test'),
      phone: emptyToUndefined('0501234567'),
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * Sweep guard — documents the verified scope so the class stays closed.
 * Of the apps/web Create*Input forms, only owner had an OPTIONAL field
 * with a constraint that rejects ''. These assertions pin WHY the other
 * candidates are not in scope, so a future schema change that breaks the
 * assumption fails here loudly.
 */
describe('§FUNC-1 sweep — scope is verified, not assumed', () => {
  it('contractor: contactEmail is REQUIRED, so rejecting a blank is correct (not the bug)', () => {
    const parsed = CreateContractorInput.safeParse({ name: 'אבן בניין בע"מ', contactEmail: '' });
    expect(parsed.success).toBe(false);
  });

  it('contractor: optional contactPhone is .max()-only, so a blank is tolerated (not in class)', () => {
    const parsed = CreateContractorInput.safeParse({
      name: 'אבן בניין בע"מ',
      contactEmail: 'office@example.test',
      contactPhone: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('task: create form only submits title/description/priority — none reject a blank optional', () => {
    const parsed = CreateTaskInput.safeParse({ title: 'בדיקה', description: '', priority: 2 });
    expect(parsed.success).toBe(true);
  });
});
