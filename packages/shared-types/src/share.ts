import { z } from 'zod';

// Canonical Share contract (Doc 11 SoT; Phase 3 Slice 6).
//
// SharePermissions is BYTE-EQUIVALENT to the locked
// packages/db/src/schema/_share-permissions.ts `sharePermissionsSchema`
// (same supersession/equivalence pattern as auth.schemas.ts). Kept here so
// the FE has the contract without importing @emapp/db (shared-types stays
// pure). T3.S.1: every object is `.strict()` — unknown permission keys are
// REJECTED (fail-closed), never silently dropped/granted.
//
// Link is by contractorId (an existing org Contractor entity). docs/09
// §3.14 phrases it `contractor_email`; using the explicit FK avoids
// putting contact PII in the grant call and matches the Contractors slice
// (recorded doc-drift — D-note in PROGRESS; no Gate-2 deviation).

const tenantFields = z
  .object({
    name: z.literal(true),
    phone: z.boolean(),
    email: z.boolean(),
    national_id: z.boolean(),
    note: z.boolean(),
  })
  .strict();

export const SharePermissionsSchema = z
  .object({
    overview: z.object({ on: z.boolean() }).strict(),
    tenants: z.object({ on: z.boolean(), fields: tenantFields }).strict(),
    documents: z
      .object({
        on: z.boolean(),
        actions: z.object({ download: z.boolean(), upload: z.boolean() }).strict(),
      })
      .strict(),
    signatures: z.object({ on: z.boolean() }).strict(),
    notes: z.object({ on: z.boolean() }).strict(),
    team: z.object({ on: z.boolean() }).strict(),
  })
  .strict();
export type SharePermissions = z.infer<typeof SharePermissionsSchema>;

export const ShareSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  contractorId: z.string().uuid(),
  permissions: SharePermissionsSchema,
  revokedAt: z.coerce.date().nullable(),
  lastAccessedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Share = z.infer<typeof ShareSchema>;

/** POST body — grant a contractor share on a project. */
export const CreateShareInput = z
  .object({
    contractorId: z.string().uuid(),
    permissions: SharePermissionsSchema,
  })
  .strict();
export type CreateShare = z.infer<typeof CreateShareInput>;

/** PATCH body — update the permission set of an active share. */
export const UpdateShareInput = z.object({ permissions: SharePermissionsSchema }).strict();
export type UpdateShare = z.infer<typeof UpdateShareInput>;

export const ListSharesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListSharesQueryDto = z.infer<typeof ListSharesQuery>;
