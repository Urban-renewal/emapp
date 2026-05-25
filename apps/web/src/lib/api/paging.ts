/**
 * Shared D.16 cursor-pagination Zod schema + types.
 *
 * §SOLID-L8 closure — was duplicated in 8 entity API files (projects,
 * buildings, apartments, owners, documents, imports, ownerships,
 * signature-requests) with three different names (`PageSchema`,
 * `OwnerPageSchema`, etc.) — all the same shape. Single source here.
 *
 * Phase 4b (Provider Admin) will reuse this verbatim.
 */
import { z } from 'zod';

export const PageSchema = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export type Page = z.infer<typeof PageSchema>;

export interface ListPage<T> {
  items: T[];
  page: Page;
}
