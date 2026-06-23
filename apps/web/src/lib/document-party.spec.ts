/**
 * document-party pins — the derived PARTY axis for the binder board.
 *
 * The board renders every document under exactly one of the 8 parties, derived
 * purely from `doc_type`. These tests pin: (1) every curated `DocumentTypeEnum`
 * member maps to a party (no enum value is silently un-bucketed), (2) the
 * specific party each known type lands in, and (3) the `other` fallback for any
 * tolerant free-text / unknown `type` so the board never drops a document.
 */
import { DocumentTypeEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { DOCUMENT_PARTIES, type DocumentParty, providerPartyForDocType } from './document-party';

describe('providerPartyForDocType — known doc types', () => {
  const cases: Array<[string, DocumentParty]> = [
    ['land_registry', 'owner'],
    ['id_document', 'owner'],
    ['financial', 'appraiser'],
    ['blueprint', 'architect'],
    ['floor_plan', 'architect'],
    ['permit', 'municipality'],
    ['agreement', 'contractor'],
    ['contract', 'contractor'],
    ['regulation', 'lawyer'],
    ['other', 'other'],
    // BINDER slice 3 — the 6 deal-party taxonomy adds.
    ['survey', 'appraiser'], // שומה / הערכת שמאי
    ['survey_map', 'surveyor'], // מפת מדידה / תשריט
    ['guarantee', 'contractor'], // ערבות / בטוחה
    ['municipal_approval', 'municipality'], // אישור / היתר עירייה
    ['schedule', 'contractor'], // לוח זמנים / תכנית עבודה
    ['legal_opinion', 'lawyer'], // חוות דעת משפטית
  ];

  it.each(cases)('maps %s → %s', (docType, party) => {
    expect(providerPartyForDocType(docType)).toBe(party);
  });
});

describe('providerPartyForDocType — completeness over the shared enum', () => {
  it('maps EVERY curated DocumentTypeEnum member to a valid party', () => {
    for (const docType of DocumentTypeEnum.options) {
      const party = providerPartyForDocType(docType);
      expect(DOCUMENT_PARTIES).toContain(party);
    }
  });
});

describe('providerPartyForDocType — tolerant fallback', () => {
  it('falls back to "other" for an unknown free-text type', () => {
    expect(providerPartyForDocType('some_legacy_type')).toBe('other');
    expect(providerPartyForDocType('')).toBe('other');
  });

  it('normalises case + surrounding whitespace before lookup', () => {
    expect(providerPartyForDocType('  Land_Registry ')).toBe('owner');
    expect(providerPartyForDocType('AGREEMENT')).toBe('contractor');
  });

  it('never throws on arbitrary input', () => {
    expect(() => providerPartyForDocType('🙂')).not.toThrow();
    expect(providerPartyForDocType('🙂')).toBe('other');
  });
});
