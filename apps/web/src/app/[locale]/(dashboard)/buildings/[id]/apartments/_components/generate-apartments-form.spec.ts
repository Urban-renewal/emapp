/**
 * Slice 2.1 — GenerateApartmentsForm render contract.
 *
 * The repo's web vitest env is `node` (no DOM / testing-library), so we render
 * the REAL component via `renderToStaticMarkup` and assert the server-rendered
 * markup. This proves:
 *  - the form is a real POST form (FE-security DoD: no GET-fallback credential/
 *    data leak — `method="post"`), and
 *  - the lead control + initial preview render with real Hebrew copy (the
 *    technophobe lens: the manager sees "כמה דירות ייווצרו" before confirming).
 *
 * The numbering math (first/last/count across schemes) is exhaustively unit-
 * tested where it lives — the shared `buildApartmentNumbers` — so this spec
 * does not re-derive it; it asserts the wiring (copy + post form + submit CTA).
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Real he.json apartments.generate strings the component renders (drift here is
// intentional signal — these are what the manager actually reads).
const GEN: Record<string, string> = {
  title: 'מילוי מהיר של דירות הבניין',
  hint: 'במקום להוסיף דירה אחת בכל פעם — מלאו את צורת הבניין והמערכת תיצור את כל הדירות בבת אחת.',
  floors: 'מספר קומות',
  apartmentsPerFloor: 'דירות בכל קומה',
  schemeLabel: 'מספור הדירות',
  'scheme.sequential': 'רץ (1, 2, 3 …)',
  'scheme.floorBased': 'לפי קומה (101, 102, 201 …)',
  previewOne: 'תיווצר דירה אחת: {first}.',
  preview: 'ייווצרו {count} דירות. הראשונה: {first} · האחרונה: {last}.',
  submit: 'צור {count} דירות',
  submitting: 'יוצר דירות…',
};

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const tmpl = GEN[key] ?? `MISSING:${key}`;
    return vars ? tmpl.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`)) : tmpl;
  },
}));

// The generate mutation — inert here; this is a render/markup probe, not an
// interaction test (node env, no DOM events). Default idle state.
vi.mock('@/hooks/use-apartments', () => ({
  useGenerateApartments: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    type,
  }: {
    children: ReactNode;
    disabled?: boolean;
    type?: string;
  }) => createElement('button', { type: type ?? 'button', disabled }, children),
}));

async function render() {
  const { GenerateApartmentsForm } = await import('./generate-apartments-form');
  return renderToStaticMarkup(createElement(GenerateApartmentsForm, { buildingId: 'b-123' }));
}

describe('GenerateApartmentsForm', () => {
  it('renders a POST form (no GET fallback) with the lead title + hint', async () => {
    const html = await render();
    expect(html).toContain('method="post"');
    expect(html).toContain(GEN.title);
    expect(html).toContain(GEN.floors);
    expect(html).toContain(GEN.apartmentsPerFloor);
  });

  it('shows the initial single-apartment preview (count=1) and the submit CTA', async () => {
    const html = await render();
    // floors=1 × perFloor=1 → 1 apartment → previewOne with first "1".
    expect(html).toContain('תיווצר דירה אחת: 1.');
    // submit CTA interpolates the count.
    expect(html).toContain('צור 1 דירות');
  });

  it('offers both numbering schemes', async () => {
    const html = await render();
    expect(html).toContain(GEN['scheme.sequential']);
    expect(html).toContain(GEN['scheme.floorBased']);
  });
});
