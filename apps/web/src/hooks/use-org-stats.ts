'use client';

import type { OrgStats } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';

import { getOrgStats } from '@/lib/api/org-stats';

/** Query key for the org situation-picture stats. */
export const ORG_STATS_QUERY_KEY = ['org', 'stats'] as const;

/**
 * The org-wide situation-picture counts (incl. the 2.6 PII-FREE document
 * future-state facet). `enabled` lets a caller skip the fetch for roles that
 * can't read org stats (an agent cannot read `GET /org/stats` org-wide).
 */
export function useOrgStats(enabled = true) {
  return useQuery<OrgStats>({
    queryKey: ORG_STATS_QUERY_KEY,
    queryFn: getOrgStats,
    enabled,
    staleTime: 30_000,
  });
}
