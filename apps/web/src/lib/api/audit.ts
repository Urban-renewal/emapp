/**
 * Audit API client — Phase 4c S4.
 *
 * Route:
 *   GET /api/v1/audit?limit=&cursor= → { data: AuditEntry[], page }
 *
 * Manager-only resource (D.17 policy.ts:68). The BE projection
 * deliberately excludes before/after diffs + ip + userAgent — only
 * who/what/target/when reach the wire.
 *
 * No write operations — audit_log is append-only by the AuditService
 * inside domain transactions. There is no DELETE / PATCH on the wire.
 */
import { AuditEntrySchema } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

export interface AuditListPage {
  items: import('@emapp/shared-types').AuditEntry[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listAuditEntries(
  query: { limit?: number; cursor?: string } = {},
): Promise<AuditListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/audit${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(AuditEntrySchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}
