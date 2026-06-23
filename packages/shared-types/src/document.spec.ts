import { describe, expect, it } from 'vitest';

import { SENSITIVE_DOC_TYPES, isSensitiveDocType } from './document';

describe('SENSITIVE_DOC_TYPES — the single FE/BE source of truth', () => {
  it('contains exactly the three PII-bearing types', () => {
    expect([...SENSITIVE_DOC_TYPES].sort()).toEqual(
      ['financial', 'id_document', 'land_registry'].sort(),
    );
  });
});

describe('isSensitiveDocType', () => {
  it('true for each sensitive-by-type doc', () => {
    expect(isSensitiveDocType('id_document')).toBe(true);
    expect(isSensitiveDocType('financial')).toBe(true);
    expect(isSensitiveDocType('land_registry')).toBe(true);
  });

  it('false for non-sensitive types', () => {
    expect(isSensitiveDocType('agreement')).toBe(false);
    expect(isSensitiveDocType('blueprint')).toBe(false);
    expect(isSensitiveDocType('other')).toBe(false);
  });

  it('is tolerant of case / whitespace (mirrors providerPartyForDocType)', () => {
    expect(isSensitiveDocType(' Land_Registry ')).toBe(true);
    expect(isSensitiveDocType('ID_DOCUMENT')).toBe(true);
  });

  it('false for an unknown free-text type (absence ≠ definitely non-sensitive)', () => {
    expect(isSensitiveDocType('totally-unknown')).toBe(false);
  });
});
