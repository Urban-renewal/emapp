/**
 * Slice 2.5 — org-level situation-picture stats client (`GET /org/stats`).
 *
 * The endpoint carries the org-wide KPI counts PLUS the PII-FREE owner legal/life-
 * state facet (`ownerStates`) — COUNTS ONLY, no names / guardian PII. Defensive
 * `.parse()` on the response (the FE never trusts the wire).
 */
import { OrgStatsSchema, type OrgStats } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

const OrgStatsDataSchema = z.object({ data: OrgStatsSchema });

export async function getOrgStats(): Promise<OrgStats> {
  const res = await apiClient.get<unknown>(`/org/stats`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OrgStatsDataSchema.parse({ data: res.data }).data;
}
