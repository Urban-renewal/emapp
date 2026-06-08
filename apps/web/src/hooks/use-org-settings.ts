'use client';

import type { OrgSettings, OrgSettingsPatch } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getOrgSettings, updateOrgSettings } from '@/lib/api/org-settings';

/**
 * Org-settings data hooks — TanStack Query (P6-1).
 *
 * `useOrgSettings` reads the fully-RESOLVED config; `useUpdateOrgSettings`
 * PATCHes a partial and invalidates the read so the UI reflects the persisted
 * value. The query is gated at the call site on `org.settings.read`
 * (`useHasPermission`) so we never fire the request for an actor who'd 403.
 */
const ORG_SETTINGS_KEY = ['org-settings'] as const;

export function useOrgSettings(options: { enabled?: boolean } = {}) {
  return useQuery<OrgSettings, Error>({
    queryKey: ORG_SETTINGS_KEY,
    queryFn: getOrgSettings,
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useUpdateOrgSettings() {
  const qc = useQueryClient();
  return useMutation<OrgSettings, Error, OrgSettingsPatch>({
    mutationFn: (patch: OrgSettingsPatch) => updateOrgSettings(patch),
    onSuccess: (resolved) => {
      // Seed the cache with the server's resolved tree, then invalidate so any
      // other consumer refetches the canonical value.
      qc.setQueryData(ORG_SETTINGS_KEY, resolved);
      qc.invalidateQueries({ queryKey: ORG_SETTINGS_KEY });
    },
  });
}
