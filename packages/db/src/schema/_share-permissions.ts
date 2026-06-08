import { z } from 'zod';

// A3 (L4): `tenants`, `notes`, `team`, and `documents.actions.upload` were
// DEAD keys (no contractor read-path consulted them) and `national_id` was a
// PII footgun. Removed so the persisted JSONB + schema reflect the only keys
// the contractor tier actually enforces. BYTE-EQUIVALENT to the shared-types
// `SharePermissionsSchema`. The 0052 migration strips the dead paths from
// every existing `shares.permissions` row so persisted data matches.
const documentActionsSchema = z
  .object({
    download: z.boolean(),
  })
  .strict();

export const sharePermissionsSchema = z
  .object({
    overview: z.object({ on: z.boolean() }).strict(),
    documents: z
      .object({
        on: z.boolean(),
        actions: documentActionsSchema,
      })
      .strict(),
    signatures: z.object({ on: z.boolean() }).strict(),
  })
  .strict();

export type SharePermissions = z.infer<typeof sharePermissionsSchema>;
