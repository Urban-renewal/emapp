/**
 * Document PARTY axis — the pure, derived `doc_type` → urban-renewal PARTY
 * mapping for the PARTY-BINDER board.
 *
 * SINGLE SOURCE OF TRUTH: the mapping + the party set now live in
 * `@emapp/shared-types` (`packages/shared-types/src/document.ts`) so the FE
 * board AND the BE `GET /documents/board-completeness` endpoint derive the
 * party from ONE definition — no second copy to drift. This module is a thin
 * FE-facing re-export kept so the existing `@/lib/document-party` import sites
 * (documents-list.client.tsx, document-completeness.ts, the spec) stay stable.
 *
 * Derivation is FE-presentation when consumed by the board buckets: there is no
 * `party` column on the wire; an unrecognised free-text `type` falls back to
 * the neutral `other` bucket so the board never silently drops a document. The
 * party LABELS are resolved at the component via next-intl (`documents.party.*`).
 */

export {
  DOCUMENT_PARTIES,
  type DocumentParty,
  providerPartyForDocType,
} from '@emapp/shared-types';
