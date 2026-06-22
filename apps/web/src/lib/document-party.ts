/**
 * Document PARTY axis — a pure, derived FE mapping from `doc_type` to the
 * urban-renewal PARTY that typically owns that document.
 *
 * The documents page used to render a flat / project-grouped wall of files —
 * "still מבולגן … a wall of files that doesn't scale and bores the
 * technophobe" (owner). The PARTY BINDER re-skin organises the SAME docs the
 * page already fetches into ~8 calm "who is responsible" buckets (owners,
 * appraiser, architect, …), the way a building-committee volunteer actually
 * thinks about a renewal file.
 *
 * This is DERIVED, FE-only presentation — there is NO `party` column on the
 * wire and NO BE endpoint. Every value of the shared `DocumentTypeEnum` MUST
 * map to exactly one party; any unrecognised free-text `type` (the read model
 * tolerantly parses `type` as a string, not the enum — see
 * `packages/shared-types/src/document.ts`) falls back to the neutral `other`
 * bucket so the board never silently drops a document.
 *
 * Pure + unit-tested (`document-party.spec.ts`). No i18n here — the party
 * LABELS are resolved at the component via next-intl (`documents.party.*`),
 * keeping this module a pure data mapping.
 */

/** The fixed set of binder parties. Order here is the canonical board order. */
export const DOCUMENT_PARTIES = [
  'owner', // בעלים — land registry / id documents
  'appraiser', // שמאי — financial appraisal (survey later)
  'architect', // אדריכל — blueprints / floor plans
  'municipality', // עירייה — permits
  'contractor', // קבלן — agreements / contracts
  'lawyer', // עו״ד — regulations / תקנון
  'supervisor', // מפקח — (no default doc_type yet)
  'surveyor', // מודד — (no default doc_type yet)
  'other', // כללי / אחר — neutral bucket + unknowns
] as const;

export type DocumentParty = (typeof DOCUMENT_PARTIES)[number];

/**
 * Default party per curated `DocumentType`. Kept as an explicit record so the
 * unit spec can assert every enum member is mapped (the "map every current
 * enum value" requirement). Unknown free-text types are handled by
 * {@link providerPartyForDocType}, not here.
 */
const PARTY_BY_DOC_TYPE: Record<string, DocumentParty> = {
  // owner — carries owner PII / the registry record
  land_registry: 'owner', // נסח טאבו
  id_document: 'owner', // תעודת זהות
  // appraiser — the financial / valuation file ('survey' joins here later)
  financial: 'appraiser',
  // architect — the drawings
  blueprint: 'architect', // תוכנית / שרטוט
  floor_plan: 'architect', // תוכנית דירה
  // municipality — the authority's approvals
  permit: 'municipality', // היתר
  // contractor — the signed renewal deal
  agreement: 'contractor', // הסכם
  contract: 'contractor',
  // lawyer — the legal framework
  regulation: 'lawyer', // תקנון / רגולציה
  // neutral
  other: 'other',
};

/**
 * Resolve the default binder PARTY for a document `type`.
 *
 * Accepts the tolerant wire `type` string (NOT only the curated enum). Any
 * value not in the explicit map — a legacy / imported free-text type — falls
 * back to `other`, so the board renders every document and never throws.
 */
export function providerPartyForDocType(docType: string): DocumentParty {
  const normalised = docType.trim().toLowerCase();
  return PARTY_BY_DOC_TYPE[normalised] ?? 'other';
}
