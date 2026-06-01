'use client';

import type {
  OnboardOrgBody,
  OnboardOrgResult,
  ProviderAuditQuery,
  TenantSuspensionState,
} from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toProviderAuditItemVMs } from '@/adapters/provider-audit';
import { toSystemHealthVM } from '@/adapters/provider-health';
import { toTenantDetailVM, toTenantListItemVMs } from '@/adapters/provider-tenant';
import {
  getSystemHealth,
  getTenant,
  listTenants,
  onboardOrg,
  reactivateTenant,
  searchAudit,
  suspendTenant,
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

/**
 * D.49 — suspend / reactivate mutations.
 *
 * Both read the session `access_reason` (the AccessReasonGate guarantees
 * it is set before any `/provider/*` page renders); the API client also
 * throws `ProviderReasonRequiredError` (code `reason_required_local`) if
 * it is somehow empty (defense in depth on top of the BE 400
 * `reason_required`). On success we invalidate the affected
 * tenant detail query so the suspended banner + the offered action flip
 * without a manual refetch. We invalidate by the `['provider','tenant']`
 * prefix (all locales) — one network round-trip, no duplicate fetch.
 */
export function useSuspendTenant(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation<TenantSuspensionState, Error, { note?: string }>({
    mutationFn: ({ note }) => {
      if (!id) throw new Error('useSuspendTenant requires an id');
      return suspendTenant(readProviderReason() ?? '', id, note);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...PROVIDER_KEY, 'tenant', id] });
      qc.invalidateQueries({ queryKey: [...PROVIDER_KEY, 'tenants'] });
    },
  });
}

export function useReactivateTenant(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation<TenantSuspensionState, Error, void>({
    mutationFn: () => {
      if (!id) throw new Error('useReactivateTenant requires an id');
      return reactivateTenant(readProviderReason() ?? '', id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...PROVIDER_KEY, 'tenant', id] });
      qc.invalidateQueries({ queryKey: [...PROVIDER_KEY, 'tenants'] });
    },
  });
}

/**
 * D.45 — onboarding mutation (create org + first-manager invite).
 *
 * Reads the session `access_reason` (AccessReasonGate guarantees it).
 * On success we invalidate the tenant list so the new org appears. The
 * one-shot `inviteToken` (dev/test only, D.27) is returned from
 * `mutateAsync` for the page to render once — NEVER written to cache.
 */
export function useOnboardOrg() {
  const qc = useQueryClient();
  return useMutation<OnboardOrgResult, Error, OnboardOrgBody>({
    mutationFn: (body) => onboardOrg(readProviderReason() ?? '', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...PROVIDER_KEY, 'tenants'] });
    },
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
