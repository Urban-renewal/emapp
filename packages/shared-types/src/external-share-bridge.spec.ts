import { describe, expect, it } from 'vitest';

import { DOCUMENT_PARTY_VALUES, type DocumentParty } from './document';
import {
  ExternalSharePartyTypeSchema,
  canAutoMintGrantFor,
  partyTypeForDocumentParty,
  shareePartyTypeFor,
} from './external-share';

/**
 * W-4.1 — the DocumentParty → ExternalSharePartyType bridge MUST be:
 *   1. TOTAL over DOCUMENT_PARTY_VALUES (every binder party mapped — no gap that
 *      could silently fall through to an auto-mint).
 *   2. FAIL-CLOSED: the four non-counterparty binder parties map to `null`, and
 *      `null` means "track-only, NEVER auto-mint a grant".
 *   3. Range-valid: every non-null target is a real ExternalSharePartyType.
 * These are the structural guards the 4.2/4.3 auto-mint paths rely on.
 */
describe('partyTypeForDocumentParty bridge — exhaustiveness + fail-closed', () => {
  it('maps EVERY DocumentParty (total over the canonical tuple)', () => {
    for (const party of DOCUMENT_PARTY_VALUES) {
      // Presence is a key existence check — a missing key would be `undefined`,
      // which is DISTINCT from an explicit `null` (track-only). Reject both gaps.
      expect(Object.prototype.hasOwnProperty.call(partyTypeForDocumentParty, party)).toBe(true);
      const mapped = partyTypeForDocumentParty[party as DocumentParty];
      expect(mapped === null || typeof mapped === 'string').toBe(true);
    }
  });

  it('has NO extra keys beyond DOCUMENT_PARTY_VALUES (no drift)', () => {
    expect(Object.keys(partyTypeForDocumentParty).sort()).toEqual(
      [...DOCUMENT_PARTY_VALUES].sort(),
    );
  });

  it('pins the EXACT auto-mintable correspondences', () => {
    expect(partyTypeForDocumentParty).toEqual({
      owner: null,
      appraiser: 'appraiser',
      architect: null,
      municipality: null,
      contractor: 'developer',
      lawyer: 'tenant_lawyer',
      supervisor: 'supervisor',
      surveyor: 'surveyor',
      other: null,
    });
  });

  it('the FOUR fail-closed (null) parties cannot auto-mint a grant', () => {
    for (const party of ['owner', 'architect', 'municipality', 'other'] as const) {
      expect(shareePartyTypeFor(party)).toBeNull();
      expect(canAutoMintGrantFor(party)).toBe(false);
    }
  });

  it('every non-null target is a valid ExternalSharePartyType (range-valid)', () => {
    for (const party of DOCUMENT_PARTY_VALUES) {
      const mapped = partyTypeForDocumentParty[party as DocumentParty];
      if (mapped !== null) {
        expect(ExternalSharePartyTypeSchema.safeParse(mapped).success).toBe(true);
        expect(canAutoMintGrantFor(party as DocumentParty)).toBe(true);
      }
    }
  });
});
