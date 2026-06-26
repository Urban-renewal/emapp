/**
 * 0.S6 #32 / #33 — the contractor read-view must render a FAILED section fetch
 * as a real error state (with retry), NEVER as a dishonest false-empty / a
 * silently-dropped section.
 *
 * Defects fixed:
 *  - #32: a FAILED documents fetch rendered the "אין מסמכים משותפים" empty
 *    state (dishonest — claims no docs are shared when the fetch actually
 *    failed).
 *  - #33: a FAILED signature-progress fetch silently dropped the whole
 *    progress section (the contractor sees nothing, with no idea it failed).
 *
 * Both now route through the canonical `<DataState>` primitive: an error →
 * the calm error + retry treatment; a genuine loaded-empty → the empty copy.
 *
 * Harness: node env, no DOM — the REAL `<ContractorSharePage>` is rendered via
 * `react-dom/server`. `useQuery` is stubbed to return a controlled state PER
 * queryKey so we can fail an individual section while keeping the project
 * fetch healthy (otherwise the whole page short-circuits to the dead-link).
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import heMessages from '@/messages/he.json';

const messages = heMessages as Record<string, Record<string, unknown>>;
function makeResolver(ns: string) {
  return (key: string, vars?: Record<string, unknown>): string => {
    const node = messages[ns]?.[key];
    let s = typeof node === 'string' ? node : `MISSING:${ns}.${key}`;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => makeResolver(ns),
}));
const tcv = makeResolver('contractorView');
const tds = makeResolver('dataState');

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@/components/ui/name-display', () => ({
  NameDisplay: ({ name }: { name: string }) => createElement('span', null, name),
}));
vi.mock('@/components/ui/status-badge', () => ({
  StatusBadge: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => createElement('div', { 'data-testid': 'skeleton' }),
}));
vi.mock('@/components/ui/list-skeleton', () => ({
  ListSkeleton: () => createElement('div', { 'data-testid': 'list-skeleton' }),
}));
vi.mock('@/adapters/project', () => ({
  PROJECT_STATUS_INTENTS: {},
  PROJECT_STATUS_LABELS: {},
  PROJECT_TYPE_LABELS: {},
}));
vi.mock('@/lib/api/contractor', () => ({
  getContractorProject: vi.fn(),
  getContractorProgress: vi.fn(),
  getContractorDocuments: vi.fn(),
  getContractorDownloadUrl: vi.fn(),
}));

// A healthy project so the page renders the sections (not the dead-link).
const HEALTHY_PROJECT = {
  project: { name: 'מגדלי הרצל', status: 'gathering_signatures', type: 'tama38' },
  permissions: { signatures: true, documents: true },
  buildings: [],
};

// Per-queryKey state injection: each test sets `byKey` to control what each
// useQuery returns based on its `queryKey[1]` ('project' | 'progress' | 'documents').
type QState = {
  data?: unknown;
  isError?: boolean;
  isLoading?: boolean;
  error?: unknown;
};
let byKey: Record<string, QState> = {};

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const which = String(queryKey[1]);
    const s = byKey[which] ?? {};
    return {
      data: s.data,
      isError: s.isError ?? false,
      isLoading: s.isLoading ?? false,
      error: s.error,
      refetch: vi.fn(),
    };
  },
}));

import ContractorSharePage from './page';

function render(): string {
  return renderToStaticMarkup(createElement(ContractorSharePage));
}

afterEach(() => {
  byKey = {};
  vi.clearAllMocks();
});

describe('0.S6 #32 — contractor documents: failed fetch is an error, NOT false-empty', () => {
  it('FAILED documents fetch shows the error+retry treatment, never "אין מסמכים משותפים"', () => {
    byKey = {
      project: { data: HEALTHY_PROJECT },
      progress: { data: { signaturesSigned: 0, signaturesTotal: 0 } },
      documents: { isError: true, error: new Error('5xx') },
    };
    const html = render();
    // Honest error copy (canonical DataState) — NOT the false-empty.
    expect(html).toContain(tds('errorTitle'));
    expect(html).not.toContain(tcv('noDocuments'));
  });

  it('GENUINE loaded-empty documents → the empty copy (not an error)', () => {
    byKey = {
      project: { data: HEALTHY_PROJECT },
      progress: { data: { signaturesSigned: 0, signaturesTotal: 0 } },
      documents: { data: [] },
    };
    const html = render();
    expect(html).toContain(tcv('noDocuments'));
    expect(html).not.toContain(tds('errorTitle'));
  });
});

describe('0.S6 #33 — contractor progress: failed fetch is an error, NOT silently dropped', () => {
  it('FAILED progress fetch renders the section heading + error treatment (section not dropped)', () => {
    byKey = {
      project: { data: HEALTHY_PROJECT },
      progress: { isError: true, error: new Error('5xx') },
      documents: { data: [] },
    };
    const html = render();
    // The section title still renders (section NOT silently dropped)...
    expect(html).toContain(tcv('progressSection'));
    // ...and it shows the honest error treatment.
    expect(html).toContain(tds('errorTitle'));
  });
});
