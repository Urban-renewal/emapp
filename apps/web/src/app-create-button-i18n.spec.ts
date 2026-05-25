/**
 * §i18n-cross-namespace-leak — entity create-button label uses correct namespace.
 *
 * Browser-smoke catch: `/he/owners/new` showed the submit button labeled
 * "צור פרויקט" (Create Project) instead of "הוסף בעל דירה" (Add Owner).
 * Root cause: a copy-paste from the project-create page kept the alias
 * `tp = useTranslations('projects')` and used `tp('create')`/`tp('creating')`
 * for the submit button, leaking the projects-namespace string into the
 * owners form. Same bug pattern was present on the apartment-create
 * (`buildings/[id]/apartments/new`) and building-create
 * (`projects/[id]/buildings/new`) pages.
 *
 * This static check pins the contract: any entity-create page that
 * renders a `<Button type="submit">` for the entity creation action
 * MUST use the SAME `useTranslations(...)` namespace as the entity it
 * creates. Borrowing `tp('create')` from projects for non-project
 * entities is the bug.
 *
 * Specifically: each entity-create page must contain `t('create')` (the
 * `t` from the page's own namespace) as the submit-button label, NOT
 * `tp('create')`. The cancel/archive borrowings from projects (lower
 * priority — same word in both languages) are NOT enforced here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, 'app/[locale]/(dashboard)');

// Entity-create pages (page.tsx files that POST to create a new entity).
// Each entry: (relative path, expected own-namespace alias, entity name for error msgs).
const CREATE_PAGES: ReadonlyArray<{ path: string; namespace: string; entity: string }> = [
  { path: 'owners/new/page.tsx', namespace: 'owners', entity: 'owner' },
  {
    path: 'buildings/[id]/apartments/new/page.tsx',
    namespace: 'apartments',
    entity: 'apartment',
  },
  {
    path: 'projects/[id]/buildings/new/page.tsx',
    namespace: 'buildings',
    entity: 'building',
  },
  { path: 'projects/new/page.tsx', namespace: 'projects', entity: 'project' },
  {
    path: 'signature-requests/new/page.tsx',
    namespace: 'signatureRequests',
    entity: 'signature-request',
  },
];

describe('§i18n-cross-namespace-leak — entity-create submit buttons use own namespace', () => {
  for (const { path, namespace, entity } of CREATE_PAGES) {
    it(`${entity} create page uses t('create')/t('creating') from "${namespace}" namespace`, () => {
      const src = readFileSync(join(WEB, path), 'utf8');

      // Page must call useTranslations(namespace) somewhere.
      // eslint-disable-next-line security/detect-non-literal-regexp -- namespace is from a hardcoded static array, not user input
      const namespaceRegex = new RegExp(`useTranslations\\(['"]${namespace}['"]\\)`);
      expect(src, `${path} must call useTranslations('${namespace}')`).toMatch(namespaceRegex);

      // The submit-button label must use `t(...)` (own ns), NOT `tp(...)`
      // (which is the projects alias). We grep for the specific pattern
      // around `type="submit"`.
      //
      // Heuristic: extract the line range from `type="submit"` to the
      // next `</Button>`. Any `tp('create')` or `tp('creating')` in that
      // range is the bug.
      const submitIdx = src.indexOf('type="submit"');
      expect(submitIdx, `${path} has no <Button type="submit">`).toBeGreaterThan(-1);
      const closeIdx = src.indexOf('</Button>', submitIdx);
      const slice = src.slice(submitIdx, closeIdx);

      expect(
        slice,
        `${entity} submit button must not use tp('create') (projects-namespace leak)`,
      ).not.toMatch(/tp\(['"]create['"]\)/);
      expect(
        slice,
        `${entity} submit button must not use tp('creating') (projects-namespace leak)`,
      ).not.toMatch(/tp\(['"]creating['"]\)/);

      // For non-project entities, the slice MUST contain t('create')
      // and t('creating') (own-namespace).
      if (namespace !== 'projects') {
        expect(slice, `${entity} submit button must use t('create')`).toMatch(
          /\bt\(['"]create['"]\)/,
        );
        expect(slice, `${entity} submit button must use t('creating')`).toMatch(
          /\bt\(['"]creating['"]\)/,
        );
      }
    });
  }
});

describe('§i18n — every entity namespace declaring `create` must also declare `creating`', () => {
  it('he.json + en.json: create ⟹ creating, per namespace', async () => {
    const here = join(__dirname, 'messages');
    const he = JSON.parse(readFileSync(join(here, 'he.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    const en = JSON.parse(readFileSync(join(here, 'en.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;

    const offendersHe: string[] = [];
    const offendersEn: string[] = [];
    for (const ns of Object.keys(he)) {
      if (he[ns] && typeof he[ns] === 'object' && 'create' in he[ns]! && !('creating' in he[ns]!)) {
        offendersHe.push(ns);
      }
    }
    for (const ns of Object.keys(en)) {
      if (en[ns] && typeof en[ns] === 'object' && 'create' in en[ns]! && !('creating' in en[ns]!)) {
        offendersEn.push(ns);
      }
    }
    expect(
      offendersHe,
      `HE namespaces with create but no creating: ${offendersHe.join(', ')}`,
    ).toEqual([]);
    expect(
      offendersEn,
      `EN namespaces with create but no creating: ${offendersEn.join(', ')}`,
    ).toEqual([]);
  });
});
