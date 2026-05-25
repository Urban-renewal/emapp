/**
 * §SOLID-L8 closure pin — PageSchema validates the D.16 cursor page shape.
 */
import { describe, expect, it } from 'vitest';

import { PageSchema } from './paging';

describe('PageSchema (D.16)', () => {
  it('accepts a valid page with cursor', () => {
    expect(PageSchema.safeParse({ limit: 25, cursor: 'abc', has_more: true }).success).toBe(true);
  });
  it('accepts a valid page with null cursor (last page)', () => {
    expect(PageSchema.safeParse({ limit: 25, cursor: null, has_more: false }).success).toBe(true);
  });
  it('rejects undefined cursor', () => {
    expect(PageSchema.safeParse({ limit: 25, has_more: false }).success).toBe(false);
  });
  it('rejects zero / negative limit', () => {
    expect(PageSchema.safeParse({ limit: 0, cursor: null, has_more: false }).success).toBe(false);
    expect(PageSchema.safeParse({ limit: -1, cursor: null, has_more: false }).success).toBe(false);
  });
  it('rejects non-int limit', () => {
    expect(PageSchema.safeParse({ limit: 25.5, cursor: null, has_more: false }).success).toBe(
      false,
    );
  });
  it('rejects non-boolean has_more', () => {
    expect(PageSchema.safeParse({ limit: 25, cursor: null, has_more: 'true' }).success).toBe(false);
  });
});
