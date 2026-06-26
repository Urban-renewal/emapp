/**
 * Slice 2.7 — org-level situation-picture stats client (`GET /org/stats`).
 *
 * The endpoint carries the org-wide KPI counts PLUS the PII-FREE apartment legal/
 * life-state facet (`apartmentStates`) — COUNTS ONLY, no person/contact fields.
 * Defensive `.parse()` on the response (the FE never trusts the wire).
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
