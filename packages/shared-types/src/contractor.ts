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

export const ListContractorsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListContractorsQueryDto = z.infer<typeof ListContractorsQuery>;
