import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_PARTY_VALUES,
  DocumentPartyEnum,
  DocumentTypeEnum,
  SENSITIVE_DOC_TYPES,
  isSensitiveDocType,
  providerPartyForDocType,
} from './document';

describe('SENSITIVE_DOC_TYPES — the single FE/BE source of truth', () => {
  it('contains exactly the four PII-bearing types', () => {
    expect([...SENSITIVE_DOC_TYPES].sort()).toEqual(
      ['financial', 'id_document', 'land_registry', 'power_of_attorney'].sort(),
    );
  });

  it('every sensitive type is a valid curated DocumentTypeEnum member', () => {
    for (const t of SENSITIVE_DOC_TYPES) {
      expect(DocumentTypeEnum.options).toContain(t);
    }
  });
});

describe('isSensitiveDocType', () => {
  it('true for each sensitive-by-type doc', () => {
    expect(isSensitiveDocType('id_document')).toBe(true);
    expect(isSensitiveDocType('financial')).toBe(true);
    expect(isSensitiveDocType('land_registry')).toBe(true);
    // S4-taxonomy — ייפוי כוח is PII-dense (national_id) → sensitive-by-type.
    expect(isSensitiveDocType('power_of_attorney')).toBe(true);
  });

  it('false for non-sensitive types (incl. the new supervisor report)', () => {
    expect(isSensitiveDocType('agreement')).toBe(false);
    expect(isSensitiveDocType('blueprint')).toBe(false);
    expect(isSensitiveDocType('other')).toBe(false);
    // inspection_report is a works report, NOT national_id-dense → non-sensitive.
    expect(isSensitiveDocType('inspection_report')).toBe(false);
  });

  it('is tolerant of case / whitespace (mirrors providerPartyForDocType)', () => {
    expect(isSensitiveDocType(' Land_Registry ')).toBe(true);
    expect(isSensitiveDocType('ID_DOCUMENT')).toBe(true);
    expect(isSensitiveDocType(' Power_Of_Attorney ')).toBe(true);
  });

  it('false for an unknown free-text type (absence ≠ definitely non-sensitive)', () => {
    expect(isSensitiveDocType('totally-unknown')).toBe(false);
  });
});

describe('providerPartyForDocType — S4-taxonomy party-gap closure', () => {
  it('maps the new types to their intended party', () => {
    // ייפוי כוח is drafted/held by the עו״ד.
    expect(providerPartyForDocType('power_of_attorney')).toBe('lawyer');
    // דו״ח פיקוח is the מפקח's report.
    expect(providerPartyForDocType('inspection_report')).toBe('supervisor');
  });

  it('EVERY binder party now has ≥1 curated doc_type mapped (no empty bucket)', () => {
    // The S4 gap: `supervisor` had zero mapped types, so מפקח docs fell to
    // `other`. After the add, every DOCUMENT_PARTY_VALUES party (except the
    // catch-all `other`, which is the unmapped bucket itself) must be reachable
    // from at least one curated DocumentTypeEnum member.
    const reached = new Set<string>();
    for (const docType of DocumentTypeEnum.options) {
      reached.add(providerPartyForDocType(docType));
    }
    for (const party of DOCUMENT_PARTY_VALUES) {
      expect(DocumentPartyEnum.options).toContain(party);
      expect(reached, `party '${party}' has no curated doc_type`).toContain(party);
    }
  });
});
