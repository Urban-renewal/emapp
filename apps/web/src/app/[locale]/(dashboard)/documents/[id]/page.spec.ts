/**
 * Documents-remediation Phase 2b — detail-page legibility.
 *
 * The bug: the detail card was near-blank — you couldn't tell a doc was
 * PII/sensitive, its AV-scan state, or which project/apartment it belonged to,
 * and an archived doc was a silent dead-end. Phase 1 put `isSensitive` /
 * `scanStatus(+Label)` / `projectName` / `apartmentName` on the VM; this slice
 * SURFACES them.
 *
 * Node vitest env (no DOM): we render the REAL component to a static SSR string
 * with the data hooks mocked per-test (same `renderToStaticMarkup` technique as
 * owners/new + apartments/new specs), and assert the REAL he.json strings show
 * up in the right STATE — not tautologies. We feed the component VM-shaped data
 * by mocking `useDocument` to return it directly (the page consumes the already-
 * adapted VM via the hook's `select`).
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import heMessages from '@/messages/he.json';
import type { DocumentViewModel } from '@/models/document.vm';

// --- next-intl: surface the REAL detail strings we assert on. --------------

const DOC = (heMessages as { documents: Record<string, unknown> }).documents as {
  detail: Record<string, string>;
  view: string;
  download: string;
};
const PROJ = (heMessages as unknown as { projects: Record<string, string> }).projects;

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => {
    const dict = ns === 'documents' ? (heMessages as Record<string, unknown>).documents : PROJ;
    // resolve dotted keys (e.g. "detail.sensitive") against the namespace object.
    const parts = key.split('.');
    let cur: unknown = dict;
    for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p];
    return typeof cur === 'string' ? cur : `MISSING:${ns}.${key}`;
  },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'doc-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

// --- permissions: caller can view + archive in these tests. ----------------
vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: () => true,
}));

// --- the data + action hooks. `useDocument` returns the VM per-test. -------
let docData: DocumentViewModel | undefined;
vi.mock('@/hooks/use-documents', () => ({
  useDocument: () => ({ data: docData, isLoading: false, isError: false, error: null }),
  useArchiveDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDownloadDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// step-up + confirm dialogs render null in these SSR snapshots.
vi.mock('@/components/step-up-unlock', () => ({
  useStepUpUnlock: () => ({ withStepUp: (fn: () => unknown) => fn(), dialog: null }),
  isStepUpCancelled: () => false,
}));
vi.mock('@/components/ui/confirm-dialog', () => ({
  useConfirm: () => ({ confirm: vi.fn(), dialog: null }),
}));

// Lightweight stand-ins so the SSR string contains the labels/links verbatim.
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...rest }: { children: ReactNode }) =>
    createElement('button', { ...rest }, children),
}));
vi.mock('@/components/ui/list-skeleton', () => ({ ListSkeleton: () => null }));
vi.mock('@/components/ui/name-display', () => ({
  NameDisplay: ({ name }: { name: string }) => createElement('bdi', null, name),
}));

import DocumentDetailPage from './page';

function vm(overrides: Partial<DocumentViewModel>): DocumentViewModel {
  return {
    id: 'doc-1',
    name: 'הסכם מכר',
    type: 'agreement',
    typeLabel: 'הסכם',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sizeLabel: '1.0 KB',
    isArchived: false,
    createdRelative: 'אתמול',
    projectId: 'proj-7',
    apartmentId: null,
    isSensitive: false,
    scanStatus: 'clean',
    scanStatusLabel: 'נסרק — תקין',
    isScanClean: true,
    projectName: 'מתחם הרצל',
    apartmentName: null,
    ...overrides,
  };
}

function render(): string {
  return renderToStaticMarkup(createElement(DocumentDetailPage));
}

afterEach(() => vi.clearAllMocks());

describe('DocumentDetailPage — Phase 2b metadata + legibility', () => {
  it('renders the metadata block: scan label + clean status + a LINK to the parent project', () => {
    docData = vm({ scanStatus: 'clean', scanStatusLabel: 'נסרק — תקין' });
    const html = render();
    expect(html).toContain(DOC.detail.metaTitle);
    expect(html).toContain(DOC.detail.scanLabel);
    expect(html).toContain('נסרק — תקין');
    // the parent project is a real navigation link, not a bare uuid.
    expect(html).toContain('href="/projects/proj-7"');
    expect(html).toContain('מתחם הרצל');
  });

  it('shows the sensitive badge + the step-up lock hint ONLY when the doc is sensitive', () => {
    docData = vm({ isSensitive: false });
    expect(render()).not.toContain(DOC.detail.sensitive);

    docData = vm({ isSensitive: true });
    const html = render();
    expect(html).toContain(DOC.detail.sensitive);
    // the lock hint sets the step-up expectation up front.
    expect(html).toContain(DOC.detail.stepUpHint);
  });

  it('an infected scan renders the danger badge variant (not the calm success one)', () => {
    docData = vm({
      scanStatus: 'infected',
      scanStatusLabel: 'נחסם — זוהתה תוכנה זדונית',
      isScanClean: false,
    });
    const html = render();
    expect(html).toContain('נחסם — זוהתה תוכנה זדונית');
    expect(html).toContain('badge-danger');
  });

  it('an archived doc is NOT a dead-end: hides View/Download, explains the archived state, offers a way out', () => {
    docData = vm({ isArchived: true });
    const html = render();
    // explanation + escape hatch present…
    expect(html).toContain(DOC.detail.archivedTitle);
    expect(html).toContain(DOC.detail.archivedBody);
    expect(html).toContain(DOC.detail.archivedToList);
    // …and the View/Download actions are gone (the BE fail-closes archived bytes).
    expect(html).not.toContain(`>${DOC.view}<`);
    expect(html).not.toContain(`>${DOC.download}<`);
  });

  it('falls back to a plain "not linked" label when there is no parent project', () => {
    docData = vm({ projectId: null, projectName: null });
    const html = render();
    expect(html).toContain(DOC.detail.noParent);
    expect(html).not.toContain('href="/projects/');
  });
});
