/**
 * Parcel-setup API client (P3a/P3b/P3c — הקמה מגוש-חלקה).
 *
 * Wire contract (apps/api parcel-setups module; docs/DESIGN-phase3-parcel-
 * autosetup.md §6):
 *  - POST  /projects/:projectId/parcel-setups → create the draft envelope.
 *    Idempotency-keyed (create-style POST, Doc 06 §5.7). The create runs the
 *    P3b provider lookup server-side and stamps providerStatus/providerCity.
 *  - PATCH /parcel-setups/:id { payload } → save the drafted buildings/
 *    apartments JSON. DRAFT-only — 409 `parcel_setup_not_draft` otherwise.
 *  - POST  /parcel-setups/:id/confirm → atomic skeleton materialization
 *    (buildings + apartments). 409 `parcel_skeleton_conflict` when parts of
 *    the skeleton already exist in the project.
 *
 * Security: the PATCH payload is built EXCLUSIVELY by the pure
 * `buildParcelPayload` seam (src/lib/parcel-payload.ts) and re-parsed here
 * with the strict shared-types schema (defense-in-depth) — the payload jsonb
 * is a public record, so no PII key may ever ride it.
 */
import {
  CreateParcelSetupInput,
  ParcelSetupSchema,
  UpdateParcelSetupPayloadInput,
  type CreateParcelSetup,
  type ParcelSetup,
  type ParcelSetupPayloadDto,
} from '@emapp/shared-types';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

/** 409 code for PATCH/confirm on a non-draft setup — "already confirmed". */
export const PARCEL_SETUP_NOT_DRAFT_CODE = 'parcel_setup_not_draft' as const;

/** 409 code for confirm when buildings/apartments already exist. */
export const PARCEL_SKELETON_CONFLICT_CODE = 'parcel_skeleton_conflict' as const;

/** POST /projects/:projectId/parcel-setups — strict body, Idempotency-Key. */
export async function createParcelSetup(
  projectId: string,
  body: CreateParcelSetup,
): Promise<ParcelSetup> {
  const res = await apiClient.postIdempotent<unknown>(
    `/projects/${projectId}/parcel-setups`,
    CreateParcelSetupInput.parse(body),
  );
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ParcelSetupSchema.parse(res.data);
}

/** PATCH /parcel-setups/:id — save the draft payload (strict re-parse). */
export async function updateParcelSetupPayload(
  id: string,
  payload: ParcelSetupPayloadDto,
): Promise<ParcelSetup> {
  const res = await apiClient.patch<unknown>(
    `/parcel-setups/${id}`,
    UpdateParcelSetupPayloadInput.parse({ payload }),
  );
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ParcelSetupSchema.parse(res.data);
}

/** POST /parcel-setups/:id/confirm — materialize the skeleton. */
export async function confirmParcelSetup(id: string): Promise<ParcelSetup> {
  const res = await apiClient.post<unknown>(`/parcel-setups/${id}/confirm`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ParcelSetupSchema.parse(res.data);
}
