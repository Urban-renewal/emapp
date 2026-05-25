/**
 * Owner ViewModel — PII discipline (CLAUDE.md hard rule).
 *
 * The wire shape already carries MASKED forms only — `nationalIdMasked`
 * + `phoneMasked` are server-controlled (last-2 / last-4 digits). The
 * adapter passes them through verbatim. The clear PII is encrypted at
 * rest (pgcrypto) and NEVER on the wire.
 *
 * PII is also NEVER in URL params (search uses POST /owners/search with
 * the value in the request body — `apps/web/src/lib/api/owners.ts`).
 */
export interface OwnerViewModel {
  id: string;
  /** Cleartext name (encrypted at rest; cleartext on the wire — Manager
   *  view only, RLS-bound). */
  name: string;
  email: string | null;
  nationalIdMasked: string;
  phoneMasked: string | null;
  notes: string | null;
  isArchived: boolean;
  createdRelative: string;
}
