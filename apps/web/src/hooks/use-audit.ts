'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toAuditEntryViewModels } from '@/adapters/audit-entry';
import { listAuditEntries, type AuditListPage } from '@/lib/api/audit';
import { useDisplayLocale } from '@/lib/locale';
import type { AuditEntryViewModel } from '@/models/audit-entry.vm';

import { auditListQueryKey } from './use-audit.keys';

export { auditListQueryKey };

/**
 * Audit-read hook (Manager-only via D.17 + the BE
 * AuditReadService.list role check). No mutation surface — the
 * audit_log is append-only and written exclusively by domain
 * transactions through AuditService.
 *
 * Cache key includes locale so HE↔EN switching re-renders the
 * adapter without a network refetch.
 */

export function useAuditList(query: { limit?: number; cursor?: string } = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: AuditListPage) => ({
      items: toAuditEntryViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    AuditListPage,
    Error,
    { items: AuditEntryViewModel[]; page: AuditListPage['page'] }
  >({
    queryKey: auditListQueryKey(query, locale),
    queryFn: () => listAuditEntries(query),
    staleTime: 30_000,
    select,
  });
}
