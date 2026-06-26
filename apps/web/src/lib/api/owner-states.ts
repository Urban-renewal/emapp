/**
 * Slice 2.5 — owner legal/life-state API client.
 *
 * PII rules: guardian identity is NEVER returned cleartext — the wire carries a
 * MASKED guardian label (`guardianNameMasked`) + a `hasGuardianContact` boolean
 * only. The create body MAY carry guardian PII (it is encrypted server-side); it
 * never round-trips back in cleartext. Defensive `.parse()` on every response.
 */
import {
  CreateOwnerStateSchema,
  OwnerStateViewSchema,
  type CreateOwnerState,
  type OwnerStateView,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

const OwnerStatesDataSchema = z.object({ data: z.array(OwnerStateViewSchema) });
const OwnerStateDataSchema = z.object({ data: OwnerStateViewSchema });

/** List the ACTIVE legal/life states on an owner (masked guardian). */
export async function listOwnerStates(ownerId: string): Promise<OwnerStateView[]> {
  const res = await apiClient.get<unknown>(`/owners/${ownerId}/states`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerStatesDataSchema.parse({ data: res.data }).data;
}

/** Record a legal/life state on an owner. Guardian PII (when supplied) is
 *  encrypted server-side; the response is masked. Idempotent create POST. */
export async function createOwnerState(
  ownerId: string,
  body: CreateOwnerState,
): Promise<OwnerStateView> {
  // Validate the body shape locally before sending (mirrors the BE DTO).
  const parsed = CreateOwnerStateSchema.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/owners/${ownerId}/states`, parsed);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerStateDataSchema.parse({ data: res.data }).data;
}

/** Resolve a legal/life state (status transition active→resolved). */
export async function resolveOwnerState(stateId: string): Promise<OwnerStateView> {
  const res = await apiClient.post<unknown>(`/owner-states/${stateId}/resolve`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerStateDataSchema.parse({ data: res.data }).data;
}
