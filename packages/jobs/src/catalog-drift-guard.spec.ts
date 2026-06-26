/**
 * 1.0 §catalog-drift-guard — static "single source of truth" ratchet.
 *
 * `docs/SYSTEM-CATALOG.html` is the declared SINGLE SOURCE OF TRUTH for the
 * system's state-space (the catalog's own closing line:
 *   "שומר-הסחיפה (CI) יפיל PR שמוסיף נתיב/enum/ממליץ שלא רשום בקטלוג").
 * This spec is that guard. It FAILS the PR when the CODE drifts from the
 * catalog along the dimensions the catalog encodes precisely:
 *
 *   1. DOMAIN ENUMS  — a domain status/kind set in code whose membership no
 *      longer matches what the catalog documents (a new value with no catalog
 *      entry, or a value the catalog lists that code dropped).
 *   2. RECOMMENDERS  — the autonomy recommenders registered in the engine must
 *      match the count the catalog's automation section declares ("4 ממליצים").
 *
 * ─── WHY a STATIC (text-read) guard, not an import-based one ───────────────
 * Like the FE ratchets (`app-no-bare-text-muted.spec.ts` et al.) this guard
 * READS SOURCE FILES AS TEXT and parses the literals out. It imports NOTHING
 * from `@emapp/db` / `@emapp/shared-types`, so:
 *   • it needs NO database / env / build (the `@emapp/jobs` suite is the DB-free
 *     leaf — this guard runs in CI with zero infra), and
 *   • it cannot be fooled by a re-export: it asserts on the literal enum
 *     declarations at their canonical source.
 *
 * ─── WHY this lives in `@emapp/jobs` ──────────────────────────────────────
 * It is cross-cutting (it reads `@emapp/db`, `@emapp/shared-types`, and the
 * worker handler). `@emapp/jobs` is the autonomy-engine leaf package, has a
 * `test` script wired into `turbo test`, and pulls in NO Postgres globalSetup —
 * so the guard is guaranteed to run in CI and stays fast.
 *
 * ─── ROBUSTNESS / NON-FLAKINESS ───────────────────────────────────────────
 * The catalog is mostly Hebrew prose. This guard ONLY parses the dimensions the
 * catalog encodes UNAMBIGUOUSLY:
 *   • status sets the catalog spells out value-by-value in Hebrew, mapped to the
 *     code literal via an EXPLICIT, in-spec translation table (project_status,
 *     apartment_status, doc_scope, proposal_status, doc scan_status) — bidirectional
 *     equality so EITHER side drifting fails;
 *   • sets the catalog declares only as a COUNT — `(18)`, `(9)` — asserted as
 *     codeCount === catalogDeclaredCount (the count is EXTRACTED from the catalog,
 *     never hard-coded here, so editing the catalog drives the guard);
 *   • the recommender count, likewise extracted from "N ממליצים".
 * Dimensions the catalog states only in informal Hebrew (proposal KINDS as
 * free-text strings, the ~200 ROUTES — already covered by the api-docs coverage
 * guard) are DELIBERATELY OUT OF SCOPE: a smaller robust guard beats a flaky big
 * one. Each failure names the drifted symbol + "add it to docs/SYSTEM-CATALOG.html
 * or remove it".
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

// ── repo layout anchors (this file: packages/jobs/src/) ───────────────────────
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CATALOG_PATH = join(REPO_ROOT, 'docs', 'SYSTEM-CATALOG.html');
const ENUMS_PATH = join(REPO_ROOT, 'packages', 'db', 'src', 'schema', '_enums.ts');
const DOCUMENT_TYPES_PATH = join(REPO_ROOT, 'packages', 'shared-types', 'src', 'document.ts');
const PROPOSAL_TYPES_PATH = join(REPO_ROOT, 'packages', 'shared-types', 'src', 'proposal.ts');
const RECOMMENDERS_DIR = join(REPO_ROOT, 'packages', 'db', 'src', 'helpers', 'recommenders');
const WORKER_HANDLER_PATH = join(
  REPO_ROOT,
  'apps',
  'worker',
  'src',
  'handlers',
  'proposal-producer.handler.ts',
);

const read = (p: string): string => readFileSync(p, 'utf8');
const CATALOG = read(CATALOG_PATH);

/**
 * Extract the string-literal members of a `z.enum([...])` / `pgEnum('name', [...])`
 * declaration from TypeScript SOURCE TEXT (not by importing — so no infra is
 * needed and a re-export cannot mask the canonical declaration). `body` is the
 * full source; `marker` is the unique declaration prefix up to the opening `[`.
 * Line `//` comments inside the array are tolerated (several enums document each
 * value inline). Throws a clear error if the declaration shape changed — a
 * silent empty match would make the guard vacuously pass.
 */
function extractStringLiteralArray(body: string, marker: string): string[] {
  const start = body.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `catalog-drift-guard: could not find \`${marker}\` — the enum declaration moved or ` +
        `was renamed. Update the marker in this guard so it keeps tracking the real source.`,
    );
  }
  const open = body.indexOf('[', start);
  const close = body.indexOf(']', open);
  if (open === -1 || close === -1 || close < open) {
    throw new Error(`catalog-drift-guard: malformed array for \`${marker}\` (no [...] block).`);
  }
  const inner = body.slice(open + 1, close);
  const literals = inner.match(/'[a-z0-9_]+'|"[a-z0-9_]+"/gi) ?? [];
  const values = literals.map((l) => l.slice(1, -1));
  if (values.length === 0) {
    throw new Error(
      `catalog-drift-guard: \`${marker}\` parsed to ZERO members — extraction is broken; ` +
        `fix the parser before trusting the gate (a vacuous pass is worse than a fail).`,
    );
  }
  return values;
}

/** Count occurrences of a global regex in a body (0 when none). */
function countMatches(body: string, re: RegExp): number {
  return body.match(re)?.length ?? 0;
}

/**
 * Read a count the catalog declares inline, e.g. `סוג(18)` or `סוג-צד(9)`.
 * `label` is the Hebrew token that immediately precedes the `(N)`. The count is
 * EXTRACTED FROM THE CATALOG (the source of truth) so changing the catalog drives
 * the guard — the number is never hard-coded in this spec.
 */
function catalogCountAfter(label: string): number {
  // `label` is ALWAYS a hardcoded Hebrew literal from this spec (never user/wire
  // input), so the dynamic RegExp carries no ReDoS/injection risk — the security
  // lint rule's concern (untrusted pattern) does not apply here.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(`${label}\\((\\d+)`);
  const m = CATALOG.match(re);
  if (!m) {
    throw new Error(
      `catalog-drift-guard: could not read the count \`${label}(N)\` from the catalog. ` +
        `If the catalog wording for "${label}" changed, update this guard's extractor.`,
    );
  }
  return Number(m[1]);
}

/**
 * Assert two membership sets are EQUAL, with a drift message that names exactly
 * which symbols are in code-not-catalog (the common "new enum value, forgot the
 * catalog" case) and catalog-not-code.
 */
function expectSameMembership(opts: {
  dimension: string;
  code: string[];
  catalog: string[];
}): void {
  const codeSet = new Set(opts.code);
  const catalogSet = new Set(opts.catalog);
  const inCodeNotCatalog = [...codeSet].filter((v) => !catalogSet.has(v));
  const inCatalogNotCode = [...catalogSet].filter((v) => !codeSet.has(v));

  if (inCodeNotCatalog.length > 0 || inCatalogNotCode.length > 0) {
    const parts: string[] = [`${opts.dimension} drifted from docs/SYSTEM-CATALOG.html.`];
    if (inCodeNotCatalog.length > 0) {
      parts.push(
        `In CODE but NOT documented in the catalog: ${inCodeNotCatalog.join(', ')} — ` +
          `add it to docs/SYSTEM-CATALOG.html or remove it from the code.`,
      );
    }
    if (inCatalogNotCode.length > 0) {
      parts.push(
        `Documented in the catalog but MISSING from code: ${inCatalogNotCode.join(', ')} — ` +
          `add it to the code or remove it from docs/SYSTEM-CATALOG.html.`,
      );
    }
    expect.fail(parts.join('\n'));
  }
}

describe('catalog-drift-guard — code must not drift from docs/SYSTEM-CATALOG.html', () => {
  // ── self-tests: prove the extractors are precise (a guard that can't catch a
  //    planted drift is worthless) ────────────────────────────────────────────
  it('the array extractor reads members and ignores inline comments (self-test)', () => {
    const sample = `export const x = pgEnum('y', [\n 'a', // one\n 'b',\n 'c',\n]);`;
    expect(extractStringLiteralArray(sample, "pgEnum('y', [")).toEqual(['a', 'b', 'c']);
  });

  it('a planted code-not-catalog value is reported (self-test)', () => {
    expect(() =>
      expectSameMembership({ dimension: 'x', code: ['a', 'b', 'ghost'], catalog: ['a', 'b'] }),
    ).toThrow(/ghost/);
  });

  it('the catalog file exists and is non-trivial (sanity)', () => {
    expect(CATALOG.length).toBeGreaterThan(1000);
    expect(CATALOG).toContain('מקור-האמת');
  });

  // ── DIMENSION 1a: project_status (D.18 LAW) — bidirectional Hebrew map ──────
  it('projectStatusEnum matches the catalog project-status set', () => {
    // catalog card "פרויקטים": "תכנון·איסוף·מאושר·בבנייה·הושלם·בוטל"
    const HEBREW_TO_LITERAL: Record<string, string> = {
      תכנון: 'planning',
      איסוף: 'gathering_signatures',
      מאושר: 'approved',
      בבנייה: 'in_construction',
      הושלם: 'completed',
      בוטל: 'cancelled',
    };
    for (const heb of Object.keys(HEBREW_TO_LITERAL)) {
      expect(CATALOG, `catalog should still list project status "${heb}"`).toContain(heb);
    }
    expectSameMembership({
      dimension: 'project_status (projectStatusEnum)',
      code: extractStringLiteralArray(read(ENUMS_PATH), "pgEnum('project_status', ["),
      catalog: Object.values(HEBREW_TO_LITERAL),
    });
  });

  // ── DIMENSION 1b: apartment_status — bidirectional Hebrew map ───────────────
  it('apartmentStatusEnum matches the catalog apartment-status set', () => {
    // catalog card "בניינים ודירות": "ממתין·נוצר-קשר·פגישה·נחתם·סירב·לא-זמין"
    const HEBREW_TO_LITERAL: Record<string, string> = {
      ממתין: 'pending',
      'נוצר-קשר': 'contacted',
      פגישה: 'meeting',
      נחתם: 'signed',
      סירב: 'refused',
      'לא-זמין': 'unreachable',
    };
    for (const heb of Object.keys(HEBREW_TO_LITERAL)) {
      expect(CATALOG, `catalog should still list apartment status "${heb}"`).toContain(heb);
    }
    expectSameMembership({
      dimension: 'apartment_status (apartmentStatusEnum)',
      code: extractStringLiteralArray(read(ENUMS_PATH), "pgEnum('apartment_status', ["),
      catalog: Object.values(HEBREW_TO_LITERAL),
    });
  });

  // ── DIMENSION 1c: doc_scope — bidirectional Hebrew map ──────────────────────
  it('docScopeEnum matches the catalog document-scope set', () => {
    // catalog card "מסמכים": "היקף(ארגון/פרויקט/דירה/בעלים)"
    const HEBREW_TO_LITERAL: Record<string, string> = {
      ארגון: 'org',
      פרויקט: 'project',
      דירה: 'apartment',
      בעלים: 'owner',
    };
    expect(CATALOG).toContain('היקף(ארגון/פרויקט/דירה/בעלים)');
    expectSameMembership({
      dimension: 'doc_scope (docScopeEnum)',
      code: extractStringLiteralArray(read(ENUMS_PATH), "pgEnum('doc_scope', ["),
      catalog: Object.values(HEBREW_TO_LITERAL),
    });
  });

  // ── DIMENSION 1d: proposal_status — bidirectional Hebrew map ────────────────
  it('ProposalStatusEnum matches the catalog inbox-status set', () => {
    // catalog card "תיבת-נכנס": "ממתין·אושר·נדחה·פג·בוצע"
    const HEBREW_TO_LITERAL: Record<string, string> = {
      ממתין: 'pending',
      אושר: 'approved',
      נדחה: 'rejected',
      פג: 'expired',
      בוצע: 'applied',
    };
    for (const heb of Object.keys(HEBREW_TO_LITERAL)) {
      expect(CATALOG, `catalog should still list inbox status "${heb}"`).toContain(heb);
    }
    expectSameMembership({
      dimension: 'proposal_status (ProposalStatusEnum)',
      code: extractStringLiteralArray(read(PROPOSAL_TYPES_PATH), 'ProposalStatusEnum = z.enum(['),
      catalog: Object.values(HEBREW_TO_LITERAL),
    });
  });

  // ── DIMENSION 1e: document scan_status — bidirectional Hebrew map ───────────
  it('DocumentScanStatusEnum matches the catalog scan-status set', () => {
    // catalog card "מסמכים": "סריקה(ממתין/נקי/נגוע/שגיאה)"
    const HEBREW_TO_LITERAL: Record<string, string> = {
      ממתין: 'pending',
      נקי: 'clean',
      נגוע: 'infected',
      שגיאה: 'error',
    };
    expect(CATALOG).toContain('סריקה(ממתין/נקי/נגוע/שגיאה)');
    expectSameMembership({
      dimension: 'document scan_status (DocumentScanStatusEnum)',
      code: extractStringLiteralArray(
        read(DOCUMENT_TYPES_PATH),
        'DocumentScanStatusEnum = z.enum([',
      ),
      catalog: Object.values(HEBREW_TO_LITERAL),
    });
  });

  // ── DIMENSION 1f: count-declared enums — code count === catalog count ───────
  it('DocumentTypeEnum size matches the catalog-declared document-type count (18)', () => {
    const codeCount = extractStringLiteralArray(
      read(DOCUMENT_TYPES_PATH),
      'DocumentTypeEnum = z.enum([',
    ).length;
    const catalogCount = catalogCountAfter('סוג'); // catalog "מסמכים" card: "סוג(18)"
    expect(
      codeCount,
      `DocumentTypeEnum has ${codeCount} values but the catalog declares סוג(${catalogCount}). ` +
        `A new document type needs a matching bump in docs/SYSTEM-CATALOG.html (or remove the value).`,
    ).toBe(catalogCount);
  });

  it('DocumentParty count matches the catalog-declared party count (9)', () => {
    const codeCount = extractStringLiteralArray(
      read(DOCUMENT_TYPES_PATH),
      'DOCUMENT_PARTY_VALUES = [',
    ).length;
    const catalogCount = catalogCountAfter('צד'); // catalog "מסמכים" card: "צד(9,נגזר)"
    expect(
      codeCount,
      `DOCUMENT_PARTY_VALUES has ${codeCount} parties but the catalog declares צד(${catalogCount}). ` +
        `Add the new party to docs/SYSTEM-CATALOG.html or remove it from the code.`,
    ).toBe(catalogCount);
  });

  it('externalSharePartyTypeEnum count matches the catalog-declared share-party count (9)', () => {
    const codeCount = extractStringLiteralArray(
      read(ENUMS_PATH),
      "pgEnum('external_share_party_type', [",
    ).length;
    const catalogCount = catalogCountAfter('סוג-צד'); // catalog "קבלנים" card: "סוג-צד(9)"
    expect(
      codeCount,
      `externalSharePartyTypeEnum has ${codeCount} values but the catalog declares סוג-צד(${catalogCount}). ` +
        `Add the new party type to docs/SYSTEM-CATALOG.html or remove it from the code.`,
    ).toBe(catalogCount);
  });

  // ── DIMENSION 2: recommenders — registered count === catalog-declared count ─
  it('the registered recommenders match the catalog automation count ("N ממליצים")', () => {
    // The canonical "what recommenders EXIST" set: one `*_RECOMMENDER_ID = '...'`
    // constant per `*.recommender.ts` file. The directory is scanned (not a fixed
    // list) so a BRAND-NEW recommender file is detected automatically — that is
    // exactly the drift the guard must catch.
    const recommenderIds = new Set<string>();
    const recommenderFiles = readdirSync(RECOMMENDERS_DIR).filter(
      (f) => f.endsWith('.recommender.ts') && !f.endsWith('.spec.ts'),
    );
    expect(recommenderFiles.length, 'expected at least one *.recommender.ts file').toBeGreaterThan(
      0,
    );
    for (const file of recommenderFiles) {
      const m = read(join(RECOMMENDERS_DIR, file)).match(/_RECOMMENDER_ID\s*=\s*'([a-z0-9-]+)'/);
      expect(m, `expected a *_RECOMMENDER_ID constant in recommenders/${file}`).not.toBeNull();
      if (m) recommenderIds.add(m[1]);
    }

    // The recommenders REGISTERED in the engine (the worker handler list). Every
    // declared recommender id must correspond to a registered `create*Recommender()`.
    const registeredCount = countMatches(read(WORKER_HANDLER_PATH), /create\w+Recommender\(\)/g);

    const catalogMatch = CATALOG.match(/(\d+)\s*ממליצים/);
    expect(
      catalogMatch,
      'catalog should declare "N ממליצים" in its automation section',
    ).not.toBeNull();
    const catalogCount = Number(catalogMatch?.[1]);

    expect(
      recommenderIds.size,
      `found ${recommenderIds.size} recommender id constants but ${registeredCount} are registered ` +
        `in the worker handler — every recommender must be registered (or its id removed).`,
    ).toBe(registeredCount);

    expect(
      registeredCount,
      `${registeredCount} recommenders are registered in the engine but the catalog declares ` +
        `"${catalogCount} ממליצים". A new recommender must be added to the automation section of ` +
        `docs/SYSTEM-CATALOG.html (or removed from the engine).`,
    ).toBe(catalogCount);
  });
});
