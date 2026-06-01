/**
 * Tenant Portal API client (V11 B.S4 wire / A.S14b consumer).
 *
 * 4 read-only endpoints under `/api/v1/portal/*`. All scoped to the
 * authenticated tenant's own owner.id at the BE — the FE never has to
 * pass an id (no `:id` path param, no `?ownerId=` query) because the
 * JWT `sub` IS the scope (audience `emapp-tenant`).
 *
 * Envelope: `/me` returns `{ data: TenantPortalMe }` (single object);
 * the other three return `{ data: TenantPortalX[] }` arrays. No cursor
 * pagination — a tenant typically owns 1 apartment + a handful of
 * docs/sigs, so the simple array envelope is correct here.
 *
 * Defensive `.parse()` on every response per ARCHITECTURE-MAP §1 —
 * the BE schema is the source of truth (packages/shared-types/portal.ts)
 * but the FE re-validates so a mid-development schema drift surfaces
 * as a parse error here rather than a runtime crash deeper in the
 * render tree.
 */
import {
  TenantPortalApartmentSchema,
  TenantPortalDocumentSchema,
  TenantPortalMeSchema,
  TenantPortalProgressSchema,
  TenantPortalSignatureSchema,
  type TenantPortalApartment,
  type TenantPortalDocument,
  type TenantPortalMe,
  type TenantPortalProgress,
  type TenantPortalSignature,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

const MeDataSchema = z.object({ data: TenantPortalMeSchema });
const ApartmentsDataSchema = z.object({ data: z.array(TenantPortalApartmentSchema) });
const DocumentsDataSchema = z.object({ data: z.array(TenantPortalDocumentSchema) });
const SignaturesDataSchema = z.object({ data: z.array(TenantPortalSignatureSchema) });
const ProgressDataSchema = z.object({ data: z.array(TenantPortalProgressSchema) });

export async function getPortalMe(): Promise<TenantPortalMe> {
  const res = await apiClient.get<unknown>('/portal/me');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return MeDataSchema.parse({ data: res.data }).data;
}

export async function getPortalApartments(): Promise<TenantPortalApartment[]> {
  const res = await apiClient.get<unknown>('/portal/apartment');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ApartmentsDataSchema.parse({ data: res.data }).data;
}

export async function getPortalDocuments(): Promise<TenantPortalDocument[]> {
  const res = await apiClient.get<unknown>('/portal/documents');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DocumentsDataSchema.parse({ data: res.data }).data;
}

export async function getPortalSignatures(): Promise<TenantPortalSignature[]> {
  const res = await apiClient.get<unknown>('/portal/signatures');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return SignaturesDataSchema.parse({ data: res.data }).data;
}

/** `GET /portal/progress` — aggregate signature progress per project the
 *  tenant has an apartment in (counts only; no other resident's data). */
export async function getPortalProgress(): Promise<TenantPortalProgress[]> {
  const res = await apiClient.get<unknown>('/portal/progress');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ProgressDataSchema.parse({ data: res.data }).data;
}
