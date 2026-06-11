/**
 * Slice 5c (FE) — project-scoped document-upload affordance: PRE-SCOPING contract.
 *
 * INDEPENDENT acceptance test, authored from the SPEC before the builder.
 *
 * SPEC (primary): the project detail page gets an in-context "upload a
 * signature document" affordance that reuses `useUploadDocument` PRE-SCOPED to
 * the project — i.e. when the manager picks a file, the upload mutation is
 * called with `projectId` set to the current project and `apartmentId` null,
 * so the doc hangs off the project WITHOUT the manager leaving for
 * /documents/new (where the upload is org-level / unparented).
 *
 * WHY a pure-logic test (repo convention): this package's dev environment does
 * NOT ship `@testing-library/react` — every web `*.spec.ts` is pure-logic only
 * and React rendering / click interaction is verified by the per-slice browser
 * smoke (see export-xlsx-button.spec.ts docstring + V11-BROWSER-SMOKE.md).
 * So a full RTL render of the affordance is NOT cleanly unit-testable here; the
 * browser smoke is the real gate for the rendered widget. What IS cleanly
 * unit-testable — and what actually pins the SPEC's load-bearing behaviour — is
 * the PURE function that maps (projectId, picked file, type, mime) → the exact
 * `useUploadDocument` mutation args. That function is the seam between the UI
 * and the hook; if it pre-scopes wrong, the doc lands org-level (a real bug).
 *
 * BUILDER CONTRACT: implement and EXPORT `buildProjectScopedUploadArgs` from
 * `./project-document-upload` (colocated with the new affordance component in
 * this `_components` folder). Signature:
 *
 *   buildProjectScopedUploadArgs(args: {
 *     projectId: string;
 *     file: File;
 *     type: DocumentType;
 *     mimeType: DocumentMime;
 *   }): UploadDocumentArgs   // the param object useUploadDocument().mutate takes
 *
 * It MUST set projectId to the given project and apartmentId to null, and pass
 * file/type/mimeType through unchanged. (Match this name/shape so this test
 * goes GREEN.)
 *
 * RED today: `./project-document-upload` does not exist → the import fails and
 * every assertion below errors. GREEN once the builder adds the helper.
 */
import type { DocumentMime, DocumentType } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { buildProjectScopedUploadArgs } from './project-document-upload';

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';

function fakeFile(name = 'agreement.pdf', type = 'application/pdf'): File {
  // jsdom-free: a minimal File works for arg-shaping (no bytes read here).
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe('Slice 5c / project-scoped upload — buildProjectScopedUploadArgs', () => {
  it('1) sets projectId to the current project', () => {
    const args = buildProjectScopedUploadArgs({
      projectId: PROJECT_ID,
      file: fakeFile(),
      type: 'agreement' as DocumentType,
      mimeType: 'application/pdf' as DocumentMime,
    });
    expect(args.projectId).toBe(PROJECT_ID);
  });

  it('2) sets apartmentId to null (project-scoped, NOT apartment-scoped)', () => {
    const args = buildProjectScopedUploadArgs({
      projectId: PROJECT_ID,
      file: fakeFile(),
      type: 'agreement' as DocumentType,
      mimeType: 'application/pdf' as DocumentMime,
    });
    // null (an explicit scope), never undefined — mirrors useUploadDocument's
    // own `apartmentId: args.apartmentId ?? null` normalisation, and is NOT the
    // org-level (both-null) upload the /documents/new page produces.
    expect(args.apartmentId).toBeNull();
  });

  it('3) is NOT an org-level upload (projectId present distinguishes it from /documents/new)', () => {
    const args = buildProjectScopedUploadArgs({
      projectId: PROJECT_ID,
      file: fakeFile(),
      type: 'agreement' as DocumentType,
      mimeType: 'application/pdf' as DocumentMime,
    });
    expect(Boolean(args.projectId)).toBe(true);
  });

  it('4) passes file / type / mimeType through unchanged', () => {
    const f = fakeFile('חוזה.pdf', 'application/pdf');
    const args = buildProjectScopedUploadArgs({
      projectId: PROJECT_ID,
      file: f,
      type: 'contract' as DocumentType,
      mimeType: 'application/pdf' as DocumentMime,
    });
    expect(args.file).toBe(f);
    expect(args.type).toBe('contract');
    expect(args.mimeType).toBe('application/pdf');
  });

  it('5) preserves the chosen mime for a non-pdf signature doc', () => {
    const f = fakeFile('signature.png', 'image/png');
    const args = buildProjectScopedUploadArgs({
      projectId: PROJECT_ID,
      file: f,
      type: 'other' as DocumentType,
      mimeType: 'image/png' as DocumentMime,
    });
    expect(args.mimeType).toBe('image/png');
    // still project-scoped regardless of the doc type / mime.
    expect(args.projectId).toBe(PROJECT_ID);
    expect(args.apartmentId).toBeNull();
  });
});
