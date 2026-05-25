'use client';

import type { ProviderAuditQuery } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toProviderAuditItemVMs } from '@/adapters/provider-audit';
import { toSystemHealthVM } from '@/adapters/provider-health';
import { toTenantDetailVM, toTenantListItemVMs } from '@/adapters/provider-tenant';
import {
  getSystemHealth,
  getTenant,
  listTenants,
  searchAudit,
  type ProviderAuditListPage,
  type TenantListPage,
} from '@/lib/api/provider';
import { useDisplayLocale } from '@/lib/locale';
import { readProviderReason } from '@/lib/provider-reason';
import type { ProviderAuditItemVM } from '@/models/provider-audit.vm';
import type { ProviderSystemHealthVM } from '@/models/provider-health.vm';
import type { ProviderTenantDetailVM, ProviderTenantListItemVM } from '@/models/provider-tenant.vm';

/**
 * TanStack Query wrappers for the D.37 Provider Admin endpoints.
 *
 * Every hook reads the `access_reason` from the session-storage store
 * via `readProviderReason()`. Pages MUST be wrapped in the
 * `AccessReasonGate` so the reason is guaranteed non-null at the
 * `enabled` boundary — if a hook fires with a null reason, the API
 * client throws `ProviderReasonRequiredError`.
 *
 * Each hook:
 *  - Runs the wire→VM adapter in `select` (memoized with useCallback,
 *    same pattern as the org-tier hooks; §PERF-H3).
 *  - `staleTime: 30_000` matches the rest of the FE; cross-tenant data
 *    is not real-time.
 *  - `enabled` gated on reason presence — fail-soft when the gate hasn't
 *    fired yet (e.g. mid-navigation).
 */

const PROVIDER_KEY = ['provider'] as const;

export function useProviderTenants(query: { limit?: number; cursor?: string } = {}) {
  const locale = useDisplayLocale();
  const reason = readProviderReason();
  const select = useCallback(
    (data: TenantListPage) => ({
      items: toTenantListItemVMs(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    TenantListPage,
    Error,
    { items: ProviderTenantListItemVM[]; page: TenantListPage['page'] }
  >({
    queryKey: [...PROVIDER_KEY, 'tenants', query, locale],
    queryFn: () => listTenants(reason ?? '', query),
    enabled: Boolean(reason),
    staleTime: 30_000,
    select,
  });
}

export function useProviderTenant(id: string | undefined) {
  const locale = useDisplayLocale();
  const reason = readProviderReason();
  const select = useCallback((data: ProviderTenantDetailVM) => data, []);
  return useQuery<ProviderTenantDetailVM, Error, ProviderTenantDetailVM>({
    queryKey: [...PROVIDER_KEY, 'tenant', id, locale],
    queryFn: async () => {
      if (!id) throw new Error('useProviderTenant requires an id');
      const wire = await getTenant(reason ?? '', id);
      return toTenantDetailVM(wire, locale);
    },
    enabled: Boolean(id) && Boolean(reason),
    staleTime: 30_000,
    select,
  });
}

export function useProviderAudit(query: ProviderAuditQuery) {
  const locale = useDisplayLocale();
  const reason = readProviderReason();
  const select = useCallback(
    (data: ProviderAuditListPage) => ({
      items: toProviderAuditItemVMs(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<
    ProviderAuditListPage,
    Error,
    { items: ProviderAuditItemVM[]; page: ProviderAuditListPage['page'] }
  >({
    queryKey: [...PROVIDER_KEY, 'audit', query, locale],
    queryFn: () => searchAudit(reason ?? '', query),
    enabled: Boolean(reason),
    staleTime: 30_000,
    select,
  });
}

export function useProviderSystemHealth() {
  const reason = readProviderReason();
  const select = useCallback(
    (data: import('@emapp/shared-types').SystemHealth) => toSystemHealthVM(data),
    [],
  );
  return useQuery<import('@emapp/shared-types').SystemHealth, Error, ProviderSystemHealthVM>({
    queryKey: [...PROVIDER_KEY, 'system-health'],
    queryFn: () => getSystemHealth(reason ?? ''),
    enabled: Boolean(reason),
    // Health gauges refresh every 30s — same staleTime as the rest of
    // the FE; pages can opt-in to refetchInterval for live tickers.
    staleTime: 30_000,
    select,
  });
}
