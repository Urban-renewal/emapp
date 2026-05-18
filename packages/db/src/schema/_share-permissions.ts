import { z } from 'zod';

const tenantFieldsSchema = z
  .object({
    name: z.literal(true),
    phone: z.boolean(),
    email: z.boolean(),
    national_id: z.boolean(),
    note: z.boolean(),
  })
  .strict();

const documentActionsSchema = z
  .object({
    download: z.boolean(),
    upload: z.boolean(),
  })
  .strict();

export const sharePermissionsSchema = z
  .object({
    overview: z.object({ on: z.boolean() }).strict(),
    tenants: z
      .object({
        on: z.boolean(),
        fields: tenantFieldsSchema,
      })
      .strict(),
    documents: z
      .object({
        on: z.boolean(),
        actions: documentActionsSchema,
      })
      .strict(),
    signatures: z.object({ on: z.boolean() }).strict(),
    notes: z.object({ on: z.boolean() }).strict(),
    team: z.object({ on: z.boolean() }).strict(),
  })
  .strict();

export type SharePermissions = z.infer<typeof sharePermissionsSchema>;
