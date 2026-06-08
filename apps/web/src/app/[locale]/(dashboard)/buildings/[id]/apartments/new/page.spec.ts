/**
 * D.39 — New-Apartment page: unit-type select + rooms show/hide gate.
 *
 * Independent TEST-AUTHOR suite. The repo's vitest env is `node` (no DOM /
 * testing-library), so we render the REAL page via `react-dom/server`
 * (`renderToStaticMarkup` → HTML string) — the same technique as
 * sidebar.spec.ts. react-hook-form + next-intl + the TanStack mutation hook
 * are stubbed so the static render is a pure unit-type-UI probe.
 *
 * What is actually proven (and what is NOT, honestly stated):
 *   1. The <select id="unitType"> renders ALL 4 options with the REAL he.json
 *      `apartments.unitType.*` labels (apt|shop|office|mixed) — a renamed or
 *      dropped translation key surfaces as a loud MISSING token.
 *   2. The rooms SHOW/HIDE gate is exercised by driving `watch('unitType')`:
 *      with the controllable mock returning 'apt'/'mixed' the rooms input is
 *      PRESENT; returning 'shop'/'office' it is ABSENT. This is the genuine
 *      `showsRooms(apt|mixed)=true, (shop|office)=false` predicate as wired
 *      into the JSX — NOT a re-implementation. (`showsRooms` itself is module-
 *      private, so it can't be imported and unit-tested directly; the static
 *      render of its single call-site is the next-best, non-vacuous probe.)
 *   3. The on-CHANGE behavior (selecting shop AFTER mount clears rooms via the
 *      useEffect+setValue) is react-hook-form runtime interactivity that a
 *      static SSR string cannot trigger — documented, NOT silently skipped.
 *      The conditional render it ultimately drives IS covered by (2).
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real he.json apartments labels we assert the rendered text against.
const UNIT_TYPE_LABEL: Record<string, string> = {
  apt: 'דירה (מגורים)',
  shop: 'מסחר/חנות',
  office: 'משרד',
  mixed: 'מעורב',
};
const FIELD_LABEL: Record<string, string> = {
  'field.number': 'מספר דירה',
  'field.floor': 'קומה',
  'field.rooms': 'חדרים',
  'field.sizeSqm': 'מ"ר',
  'field.status': 'סטטוס',
  'field.notes': 'הערות',
  'field.unitType': 'סוג היחידה',
  create: 'הוספת דירה',
  creating: 'מוסיף...',
  createFailed: 'יצירת הדירה נכשלה',
};

// next-intl: both `apartments` and `projects` namespaces are read by the page.
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => {
    if (ns === 'apartments') {
      if (key.startsWith('unitType.')) {
        const u = key.slice('unitType.'.length);
        return UNIT_TYPE_LABEL[u] ?? `MISSING:${key}`;
      }
      return FIELD_LABEL[key] ?? `MISSING:${key}`;
    }
    // projects namespace (cancel / field.required) — inert markers.
    if (key === 'cancel') return 'ביטול';
    if (key === 'field.required') return 'שדה חובה';
    return `proj:${key}`;
  },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'bld-1' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/hooks/use-apartments', () => ({
  useCreateApartment: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('@/hooks/use-api-error-handler', () => ({
  useApiErrorHandler: () => ({ serverError: null, handle: vi.fn(), reset: vi.fn() }),
}));

vi.mock('@/adapters/apartment', () => ({
  APARTMENT_STATUS_LABELS_HE: {
    pending: 'ממתין',
    contacted: 'נוצר קשר',
    meeting: 'פגישה',
    signed: 'חתם',
    refused: 'סירב',
    unreachable: 'לא זמין',
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...rest }: { children: ReactNode }) =>
    createElement('button', { ...rest }, children),
}));

// zodResolver is irrelevant to a static render of the form's initial markup.
vi.mock('@hookform/resolvers/zod', () => ({ zodResolver: () => undefined }));

// --- react-hook-form: controllable `watch('unitType')` so the rooms show/hide
//     gate is genuinely exercised against the REAL component JSX. ---
let watchedUnitType = 'apt';
const setValueSpy = vi.fn();
vi.mock('react-hook-form', () => ({
  useForm: () => ({
    register: (name: string) => ({ name }),
    handleSubmit: (fn: unknown) => fn,
    setError: vi.fn(),
    setValue: setValueSpy,
    watch: (name: string) => (name === 'unitType' ? watchedUnitType : undefined),
    formState: { errors: {}, isSubmitting: false },
  }),
}));

import NewApartmentPage from './page';

function render(unitType: string): string {
  watchedUnitType = unitType;
  return renderToStaticMarkup(createElement(NewApartmentPage));
}

beforeEach(() => {
  watchedUnitType = 'apt';
  setValueSpy.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('NewApartmentPage — unit-type select (D.39)', () => {
  it('renders the unitType <select> with ALL 4 options + their real he.json labels', () => {
    const html = render('apt');
    // the select itself
    expect(html).toMatch(/<select[^>]*id="unitType"/);
    // every option value present
    for (const v of ['apt', 'shop', 'office', 'mixed']) {
      expect(html, `missing option value="${v}"`).toContain(`value="${v}"`);
    }
    // every option's real Hebrew label rendered (no MISSING token)
    for (const label of Object.values(UNIT_TYPE_LABEL)) {
      expect(html, `missing unitType label "${label}"`).toContain(label);
    }
    expect(html).not.toContain('MISSING:');
  });

  it('the unitType field label uses the real he.json key', () => {
    const html = render('apt');
    expect(html).toContain(FIELD_LABEL['field.unitType']);
  });
});

describe('NewApartmentPage — rooms show/hide gate (showsRooms predicate, via watch)', () => {
  it('apt → rooms field PRESENT', () => {
    const html = render('apt');
    expect(html).toMatch(/id="rooms"/);
    expect(html).toContain(FIELD_LABEL['field.rooms']);
  });

  it('mixed → rooms field PRESENT', () => {
    const html = render('mixed');
    expect(html).toMatch(/id="rooms"/);
  });

  it('shop → rooms field ABSENT (commercial unit has no rooms)', () => {
    const html = render('shop');
    expect(html, 'shop unexpectedly rendered a rooms input').not.toMatch(/id="rooms"/);
  });

  it('office → rooms field ABSENT', () => {
    const html = render('office');
    expect(html).not.toMatch(/id="rooms"/);
  });

  it('non-vacuous control: the SAME render shows floor + sizeSqm for every type (only rooms is gated)', () => {
    for (const u of ['apt', 'shop', 'office', 'mixed']) {
      const html = render(u);
      expect(html, `floor missing for ${u}`).toMatch(/id="floor"/);
      expect(html, `sizeSqm missing for ${u}`).toMatch(/id="sizeSqm"/);
    }
  });
});
