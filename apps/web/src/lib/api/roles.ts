/**
 * Roles API client — P2 Phase 1 (custom permission groups + assign/revoke).
 *
 * BE contract:
 *   GET    /api/v1/roles               → { data: RoleSummary[] }  (system + custom)
 *   GET    /api/v1/roles/catalog       → { data: PermissionCatalogEntry[] }
 *   POST   /api/v1/roles               → { data: RoleSummary }    (roles.manage)
 *   PATCH  /api/v1/roles/:id           → { data: RoleSummary }    (roles.manage)
 *   DELETE /api/v1/roles/:id           → 204                       (roles.manage)
 *   POST   /api/v1/roles/assignments   → 204                       (roles.assign)
 *   DELETE /api/v1/roles/assignments   → 204                       (roles.revoke)
 *
 * Defensive Zod parse on every response (docs/ARCHITECTURE-MAP §1).
 */
import {
  AssignRoleInput,
  CreateCustomRoleInput,
  PermissionCatalogEntrySchema,
  RevokeRoleInput,
  RoleSummarySchema,
  UpdateCustomRoleInput,
  type AssignRole,
  type CreateCustomRole,
  type PermissionCatalogEntry,
  type RevokeRole,
  type RoleSummary,
  type UpdateCustomRole,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';

const RoleDataSchema = z.object({ data: RoleSummarySchema });
const RoleListSchema = z.object({ data: z.array(RoleSummarySchema) });
const CatalogSchema = z.object({ data: z.array(PermissionCatalogEntrySchema) });

export async function listRoles(): Promise<RoleSummary[]> {
  const res = await apiClient.get<unknown>(`/roles`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return RoleListSchema.parse({ data: res.data }).data;
}

export async function getPermissionCatalog(): Promise<PermissionCatalogEntry[]> {
  const res = await apiClient.get<unknown>(`/roles/catalog`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return CatalogSchema.parse({ data: res.data }).data;
}

export async function createRole(body: CreateCustomRole): Promise<RoleSummary> {
  const validated = CreateCustomRoleInput.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/roles`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return RoleDataSchema.parse({ data: res.data }).data;
}

export async function updateRole(id: string, body: UpdateCustomRole): Promise<RoleSummary> {
  const validated = UpdateCustomRoleInput.parse(body);
  const res = await apiClient.patch<unknown>(`/roles/${id}`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return RoleDataSchema.parse({ data: res.data }).data;
}

export async function deleteRole(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/roles/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return; // 204
  throw new ApiClientError(res.error);
}

export async function assignRole(body: AssignRole): Promise<void> {
  const validated = AssignRoleInput.parse(body);
  const res = await apiClient.post<unknown>(`/roles/assignments`, validated);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return; // 204
  throw new ApiClientError(res.error);
}

export async function revokeRole(body: RevokeRole): Promise<void> {
  const validated = RevokeRoleInput.parse(body);
  // DELETE with a body — the api-client delete spreads `init`, so the body is
  // honoured. Revoke is a (user, role) pair, naturally a DELETE.
  const res = await apiClient.delete<unknown>(`/roles/assignments`, {
    body: JSON.stringify(validated),
    headers: { 'Content-Type': 'application/json' },
  });
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return; // 204
  throw new ApiClientError(res.error);
}
