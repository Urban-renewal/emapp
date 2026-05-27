'use client';

import type {
  TenantPortalApartment,
  TenantPortalDocument,
  TenantPortalMe,
  TenantPortalSignature,
} from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  toPortalApartmentRowViewModels,
  toPortalDocumentViewModels,
  toPortalMeViewModel,
  toPortalSignatureViewModels,
} from '@/adapters/portal';
import {
  getPortalApartments,
  getPortalDocuments,
  getPortalMe,
  getPortalSignatures,
} from '@/lib/api/portal';
import { useDisplayLocale } from '@/lib/locale';
import type {
  PortalApartmentRowViewModel,
  PortalDocumentViewModel,
  PortalMeViewModel,
  PortalSignatureViewModel,
} from '@/models/portal.vm';

/**
 * V11 A.S14b — TanStack Query wrappers for the 4 portal endpoints.
 *
 * Cache key family: `['portal', ...]` — a `queryClient.invalidateQueries({ queryKey: ['portal'] })`
 * fully refreshes the tenant view. We never share this key with the
 * org-tier hooks (e.g. `['documents']`) because the responses are
 * tenant-scoped at the BE; cache hits across tiers would be a
 * privilege-confusion class bug. Logging out clears the entire
 * QueryClient (via the (tenant) layout unmount on redirect).
 *
 * staleTime: 30s — same as the org-tier hooks. Portal data shifts
 * slowly (the manager uploads a doc / sends a signature request), so
 * a 30s freshness window with `refetchOnWindowFocus` keeps the tenant
 * within a minute of truth.
 */

const PORTAL_KEY = ['portal'] as const;

export function usePortalMe() {
  return useQuery<TenantPortalMe, Error, PortalMeViewModel>({
    queryKey: [...PORTAL_KEY, 'me'],
    queryFn: getPortalMe,
    staleTime: 30_000,
    select: toPortalMeViewModel,
  });
}

export function usePortalApartments() {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: TenantPortalApartment[]) => toPortalApartmentRowViewModels(data, locale),
    [locale],
  );
  return useQuery<TenantPortalApartment[], Error, PortalApartmentRowViewModel[]>({
    queryKey: [...PORTAL_KEY, 'apartments', locale],
    queryFn: getPortalApartments,
    staleTime: 30_000,
    select,
  });
}

export function usePortalDocuments() {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: TenantPortalDocument[]) => toPortalDocumentViewModels(data, locale),
    [locale],
  );
  return useQuery<TenantPortalDocument[], Error, PortalDocumentViewModel[]>({
    queryKey: [...PORTAL_KEY, 'documents', locale],
    queryFn: getPortalDocuments,
    staleTime: 30_000,
    select,
  });
}

export function usePortalSignatures() {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: TenantPortalSignature[]) => toPortalSignatureViewModels(data, locale),
    [locale],
  );
  return useQuery<TenantPortalSignature[], Error, PortalSignatureViewModel[]>({
    queryKey: [...PORTAL_KEY, 'signatures', locale],
    queryFn: getPortalSignatures,
    staleTime: 30_000,
    select,
  });
}
