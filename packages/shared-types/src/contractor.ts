import { z } from 'zod';

// Canonical Contractor contract (Doc 11 SoT; Phase 3 Slice 6).
// Locked-schema aligned (contractors: orgId, name, contactEmail (citext,
// unique/org active), contactPhone, companyId, specialty, notes,
// archivedAt). Org-scoped → direct RLS.

export const ContractorSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(200),
  contactEmail: z.string().email(),
  contactPhone: z.string().max(20).nullable(),
  companyId: z.string().max(50).nullable(),
  specialty: z.string().max(200).nullable(),
  notes: z.string().max(2000).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Contractor = z.infer<typeof ContractorSchema>;

const contractorWriteShape = {
  name: z.string().min(1).max(200),
  contactEmail: z.string().email(),
  contactPhone: z.string().max(20).nullable().optional(),
  companyId: z.string().max(50).nullable().optional(),
  specialty: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
} as const;

export const CreateContractorInput = z.object(contractorWriteShape).strict();
export type CreateContractor = z.infer<typeof CreateContractorInput>;

export const UpdateContractorInput = z.object(contractorWriteShape).partial().strict();
export type UpdateContractor = z.infer<typeof UpdateContractorInput>;

/**
 * GET list query — cursor pagination + additive server-side search/filter.
 *
 * Mirrors `ListProjectsQuery` (the canonical list-filter idiom) and the
 * `external_shares` `partyType` filter: ALL filter params are optional, and
 * when ALL are absent the endpoint behaves EXACTLY as before (same rows, same
 * keyset order). The BE returns only the matching page — there is NO
 * client-filter-over-one-page (a flat wall at scale).
 *
 *  - `q`         → contractor NAME substring (case-insensitive ILIKE). Trimmed,
 *                  bounded; an empty / all-whitespace value is "no filter".
 *  - `specialty` → EXACT specialty match. `specialty` is free text (not an
 *                  enum), so the FE facet chips are DATA-DERIVED from the
 *                  `facets.specialties` the list response carries — the chips
 *                  reflect what actually exists in the org, never a hardcoded set.
 */
export const ListContractorsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  specialty: z.string().trim().min(1).max(200).optional(),
});
export type ListContractorsQueryDto = z.infer<typeof ListContractorsQuery>;
