'use client';

import { UserProfileSchema, type UserProfile } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';

import { ApiClientError } from '@/lib/api/errors';
import { apiClient, isOk } from '@/lib/api-client';

/**
 * Client-side current-user profile (`GET /api/v1/me`) for UX gating only.
 *
 * The dashboard layout already resolves the session SERVER-side; this hook
 * exposes the same `role` to client components that need to gate UI (e.g.
 * the owner "Reveal PII" button — show for manager/agent, hide for viewer).
 * It is UX only — every privileged action is gated SERVER-side regardless
 * of what this returns. Long staleTime + shared cache key → one fetch per
 * session, no duplicate calls.
 *
 * The dashboard layout SEEDS this cache from the server-resolved profile
 * (see `QueryProvider`), so the very first paint already has the role and
 * this hook makes NO `/me` fetch — it only refetches after `staleTime`.
 * The key is exported so the seed and the read can never drift apart.
 */
export const SESSION_ME_QUERY_KEY = ['session', 'me'] as const;

export function useSessionProfile() {
  return useQuery<UserProfile, Error>({
    queryKey: SESSION_ME_QUERY_KEY,
    queryFn: async () => {
      const res = await apiClient.get<unknown>('/me');
      if (!isOk(res)) throw new ApiClientError(res.error);
      return UserProfileSchema.parse(res.data);
    },
    staleTime: 5 * 60_000,
  });
}
