/**
 * Slice 2.7 — apartment legal/life-state API client.
 *
 * PII-FREE: apartment-states carry NO person/contact fields — `subKind`/`note` are
 * bounded non-PII labels. Defensive `.parse()` on every response.
 */
import {
  ApartmentStateViewSchema,
  CreateApartmentStateSchema,
  type ApartmentStateView,
  type CreateApartmentState,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

const ApartmentStatesDataSchema = z.object({ data: z.array(ApartmentStateViewSchema) });
const ApartmentStateDataSchema = z.object({ data: ApartmentStateViewSchema });

/** List the ACTIVE legal/life states on an apartment. */
export async function listApartmentStates(apartmentId: string): Promise<ApartmentStateView[]> {
  const res = await apiClient.get<unknown>(`/apartments/${apartmentId}/states`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ApartmentStatesDataSchema.parse({ data: res.data }).data;
}

/** Record a legal/life state on an apartment. Idempotent create POST. */
export async function createApartmentState(
  apartmentId: string,
  body: CreateApartmentState,
): Promise<ApartmentStateView> {
  // Validate the body shape locally before sending (mirrors the BE DTO).
  const parsed = CreateApartmentStateSchema.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/apartments/${apartmentId}/states`, parsed);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ApartmentStateDataSchema.parse({ data: res.data }).data;
}

/** Resolve a legal/life state (status transition active→resolved). */
export async function resolveApartmentState(stateId: string): Promise<ApartmentStateView> {
  const res = await apiClient.post<unknown>(`/apartment-states/${stateId}/resolve`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ApartmentStateDataSchema.parse({ data: res.data }).data;
}
