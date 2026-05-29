/**
 * gen-api-docs (Doc 09 §1.4) — generates docs/09-api-reference.generated.md
 * from the Zod request schemas (source of truth) + the endpoint registry.
 *
 *   pnpm --filter @emapp/api gen:api-docs          # write
 *   pnpm --filter @emapp/api gen:api-docs:check    # CI: exit 1 if stale
 *
 * Field types/validation are derived via zod-to-json-schema from the REAL
 * schemas, so the doc cannot drift from the contract. Output is fully
 * deterministic (stable ordering, no timestamps) so --check is reliable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AcceptInviteInput,
  CreateApartmentInput,
  CreateBuildingInput,
  CreateMemberInput,
  ListMembersQuery,
  UpdateMemberInput,
  AssignTaskInput,
  CreateContractorInput,
  CreateNoteInput,
  CreateOwnerInput,
  CreateProjectAssignmentInput,
  CreateProjectInput,
  CreateShareInput,
  CreateTaskInput,
  ListApartmentsQuery,
  ListAuditQuery,
  ListBuildingsQuery,
  ListContractorsQuery,
  ListNotesQuery,
  ListNotificationsQuery,
  ListOwnersQuery,
  ListProjectAssignmentsQuery,
  ListOwnershipsQuery,
  ListProjectsQuery,
  ListSharesQuery,
  ListTasksQuery,
  OtpRequestSchema,
  OtpVerifySchema,
  OwnerSearchInput,
  SetOwnershipsInput,
  UpdateApartmentInput,
  UpdateBuildingInput,
  UpdateContractorInput,
  UpdateOwnerInput,
  UpdateProjectInput,
  UpdateNoteInput,
  UpdateShareInput,
  UpdateTaskInput,
  CreateImportInput,
  StartImportInput,
  SubmitMappingInput,
  ListImportErrorsQuery,
  // D.37 / Phase 6.5 — Provider Admin BE read-only surface.
  ListTenantsQuerySchema,
  ProviderAuditQuerySchema,
} from '@emapp/shared-types';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { LoginSchema, OrgSwitchSchema } from '../src/modules/auth/dto/login.dto';
import { SignupSchema } from '../src/modules/auth/dto/signup.dto';
import { ProviderLoginSchema } from '../src/modules/auth/provider/provider-login.dto';

interface Endpoint {
  method: string;
  path: string;
  auth: string;
  summary: string;
  request?: ZodTypeAny;
  response: string;
  errors: string[];
}

// Routing facts are explicit; field shapes/validation come from the Zod
// schemas via zod-to-json-schema (the schema is the source of truth).
const ENDPOINTS: Endpoint[] = [
  {
    method: 'POST',
    path: '/api/v1/auth/signup',
    auth: 'Public',
    summary: 'Create org + first manager + session (atomic). Anti-enumeration.',
    request: SignupSchema,
    response: '{ "data": { "user": { "id","name","email","role":"manager","organization":{} } } }',
    errors: ['validation_error', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/login',
    auth: 'Public',
    summary: 'Password login. Generic failure (anti-enumeration), silent lockout.',
    request: LoginSchema,
    response: '{ "data": { "user": { ...profile } } }  (+ httpOnly cookies)',
    errors: ['validation_error', 'invalid_credentials', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    auth: 'Cookie (refresh_token)',
    summary: 'Rotate refresh; reuse-detection purges the chain.',
    response: '{ "data": { "ok": true } }  (+ rotated cookies)',
    errors: ['missing_refresh_token', 'invalid_refresh'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/logout',
    auth: 'AuthGuard',
    summary: 'Revoke all sessions for the user (immediate access kill).',
    response: '{ "data": { "ok": true } }',
    errors: ['missing_token', 'invalid_token', 'token_expired', 'session_revoked'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/switch-org',
    auth: 'AuthGuard',
    summary: 'Re-issue access token bound to another org the user belongs to.',
    request: OrgSwitchSchema,
    response: '{ "data": { "role": "manager|agent|viewer" } }',
    errors: ['validation_error', 'missing_token', 'invalid_token', 'token_expired', 'not_member'],
  },
  {
    method: 'GET',
    path: '/api/v1/me',
    auth: 'AuthGuard',
    summary: 'Current user profile + active organization.',
    response: '{ "data": { "id","name","email","role","avatarColor","organization":{} } }',
    errors: ['missing_token', 'invalid_token', 'token_expired', 'session_revoked'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/otp/request',
    auth: 'Public (Tenant SMS, D.20)',
    summary: 'Request a Tenant SMS OTP. Always generic 200 (anti-enumeration).',
    request: OtpRequestSchema,
    response: '{ "data": { "ok": true } }',
    errors: ['validation_error', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/otp/verify',
    auth: 'Public (Tenant SMS, D.20)',
    summary: 'Verify OTP → short-lived tenant_access cookie (own-record-only).',
    request: OtpVerifySchema,
    response: '{ "data": { "ok": true } }  (+ tenant_access cookie)',
    errors: ['validation_error', 'invalid_otp', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/provider/auth/login',
    auth: 'Public (MFA mandatory)',
    summary: 'Provider Admin: argon2 password AND TOTP/recovery. No password-only.',
    request: ProviderLoginSchema,
    response: '{ "data": { "ok": true } }  (+ provider_* cookies)',
    errors: ['validation_error', 'invalid_credentials', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/provider/auth/refresh',
    auth: 'Cookie (provider_refresh_token)',
    summary: 'Provider session rotation + reuse-detection (4h refresh).',
    response: '{ "data": { "ok": true } }',
    errors: ['missing_refresh_token', 'invalid_refresh'],
  },
  {
    method: 'POST',
    path: '/api/v1/provider/auth/logout',
    auth: 'ProviderAuthGuard',
    summary: 'Revoke all provider sessions.',
    response: '{ "data": { "ok": true } }',
    errors: ['missing_token', 'invalid_token', 'token_expired', 'session_revoked'],
  },
  {
    method: 'GET',
    path: '/api/v1/projects',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List org projects, cursor-paginated (keyset). Agent sees only assigned projects (D.17).',
    request: ListProjectsQuery,
    response:
      '{ "data": [ {Project} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/projects/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one project by id (org-scoped via RLS; Agent → assigned only).',
    response: '{ "data": { ...Project } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/projects',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Create a project. Manager only; org/createdBy injected from JWT.',
    request: CreateProjectInput,
    response: '{ "data": { ...Project } }',
    errors: ['validation_error', 'forbidden', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/projects/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Partial update. Manager only. Every field optional.',
    request: UpdateProjectInput,
    response: '{ "data": { ...Project } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/projects/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Soft delete (archivedAt — "ארכוב", not physical). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/projects/:projectId/buildings',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List buildings of a project, cursor-paginated. Via-parent org isolation; Agent → assigned projects only.',
    request: ListBuildingsQuery,
    response:
      '{ "data": [ {Building} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/projects/:projectId/buildings',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Create a building under a project. Manager only; projectId from the URL.',
    request: CreateBuildingInput,
    response: '{ "data": { ...Building } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/buildings/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one building by id (via-parent org scope; Agent → assigned project only).',
    response: '{ "data": { ...Building } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/buildings/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Partial update. Manager only. Every field optional.',
    request: UpdateBuildingInput,
    response: '{ "data": { ...Building } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/buildings/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Soft delete (archivedAt — "ארכוב"). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/buildings/:buildingId/apartments',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List apartments of a building, cursor-paginated. Via-parent isolation; Agent → assigned projects only.',
    request: ListApartmentsQuery,
    response:
      '{ "data": [ {Apartment} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/buildings/:buildingId/apartments',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Create an apartment under a building. Manager only; buildingId from the URL.',
    request: CreateApartmentInput,
    response: '{ "data": { ...Apartment } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/apartments/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one apartment by id (via-parent org scope; Agent → assigned project only).',
    response: '{ "data": { ...Apartment } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/apartments/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Partial update. Manager only. statusChangedAt advances only on a real status change.',
    request: UpdateApartmentInput,
    response: '{ "data": { ...Apartment } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/apartments/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Soft delete (archivedAt — "ארכוב"). Idempotent, preserves audit trail. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/owners',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List org owners, cursor-paginated. PII (national_id/phone) returned MASKED only (decrypted+masked in SQL).',
    request: ListOwnersQuery,
    response:
      '{ "data": [ {Owner — nationalIdMasked,phoneMasked} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/owners/search',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'HMAC lookup by national_id/phone. PII in the BODY (never URL) so it cannot leak to access logs; matched by stored HMAC.',
    request: OwnerSearchInput,
    response: '{ "data": [ {Owner — masked} ] }',
    errors: ['validation_error', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/owners',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Create an owner. national_id: 9 digits + Israeli MOD-10 checksum; phone normalized to E.164. PII encrypted at rest.',
    request: CreateOwnerInput,
    response: '{ "data": { ...Owner (masked) } }',
    errors: [
      'validation_error',
      'forbidden',
      'owner_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/owners/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one owner by id (org-scoped via RLS). PII masked.',
    response: '{ "data": { ...Owner (masked) } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/owners/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Partial update. Manager only. PII re-encrypted/re-hashed when changed.',
    request: UpdateOwnerInput,
    response: '{ "data": { ...Owner (masked) } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'owner_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/owners/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Soft delete (archivedAt — "ארכוב"). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/apartments/:apartmentId/ownerships',
    auth: 'AuthGuard + TenantGuard',
    summary: 'List ACTIVE ownerships of an apartment, cursor-paginated. Via-parent isolation.',
    request: ListOwnershipsQuery,
    response:
      '{ "data": [ {Ownership} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/apartments/:apartmentId/owners',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'Masked owners of an apartment + their share (docs/09 §3.13). PII masked in SQL; via-parent isolation.',
    request: ListOwnershipsQuery,
    response:
      '{ "data": [ {Owner masked + ownershipPct,role} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'PUT',
    path: '/api/v1/apartments/:apartmentId/ownerships',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Atomically REPLACE the apartment ownership set (locked Phase-1 trigger: active shares total 0 or exactly 100). Empty owners clears all.',
    request: SetOwnershipsInput,
    response: '{ "data": [ {Ownership} ] }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'ownership_sum_invalid',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/contractors',
    auth: 'AuthGuard + TenantGuard',
    summary: 'List org contractors, cursor-paginated. Org-scoped (direct RLS).',
    request: ListContractorsQuery,
    response:
      '{ "data": [ {Contractor} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/contractors',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Create a contractor. Manager only. Unique contactEmail per org (active).',
    request: CreateContractorInput,
    response: '{ "data": { ...Contractor } }',
    errors: [
      'validation_error',
      'forbidden',
      'contractor_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/contractors/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one contractor by id (org-scoped via RLS).',
    response: '{ "data": { ...Contractor } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/contractors/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Partial update. Manager only. Every field optional.',
    request: UpdateContractorInput,
    response: '{ "data": { ...Contractor } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'contractor_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/contractors/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Soft delete (archivedAt — "ארכוב"). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/projects/:projectId/shares',
    auth: 'AuthGuard + TenantGuard',
    summary: 'List ACTIVE shares of a project, cursor-paginated. Via-parent isolation.',
    request: ListSharesQuery,
    response:
      '{ "data": [ {Share} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/projects/:projectId/shares',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Grant a contractor a share on the project. permissions is a strict JSONB (T3.S.1 — unknown keys rejected, fail-closed).',
    request: CreateShareInput,
    response: '{ "data": { ...Share } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'contractor_invalid',
      'share_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/shares/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Replace the permission set of an active share (strict JSONB).',
    request: UpdateShareInput,
    response: '{ "data": { ...Share } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/shares/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Revoke the share (revokedAt + revokedBy — lifecycle, not physical). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/tasks',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List org tasks, cursor-paginated. Agent sees ONLY tasks assigned to them (T3.T.1, service-layer).',
    request: ListTasksQuery,
    response:
      '{ "data": [ {Task} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/tasks',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Create a task. Manager only. Optional assigneeIds seed task_assignees (org members).',
    request: CreateTaskInput,
    response: '{ "data": { ...Task } }',
    errors: [
      'validation_error',
      'forbidden',
      'invalid_assignee',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/tasks/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one task (org-scoped; Agent → only if assigned).',
    response: '{ "data": { ...Task } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/tasks/:id',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'Update. Manager: any field. Agent (assigned): status/description only. status=completed sets completedAt/By.',
    request: UpdateTaskInput,
    response: '{ "data": { ...Task } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/tasks/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Soft delete (archivedAt — "ארכוב"). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/tasks/:id/assignees',
    auth: 'AuthGuard + TenantGuard',
    summary: 'List assignees of a task (visible iff the task is visible to the caller).',
    response: '{ "data": [ {TaskAssignee} ] }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/tasks/:id/assignees',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Assign an org member to the task. Unique (task,user) → assignee_exists.',
    request: AssignTaskInput,
    response: '{ "data": { ...TaskAssignee } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'invalid_assignee',
      'assignee_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/tasks/:id/assignees/:userId',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Unassign a user from the task. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/projects/:id/export',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'V11 B.S10 (Phase 7) — Download a project as xlsx or PDF. Manager/Agent/Viewer (mounted under `projects` POLICY read=ALL). Agent scope-to-assigned enforced by `ExportComposerService` INNER-JOIN project_assignments. Throttle: 10/hour/user. Response: binary buffer + RFC 6266 / 5987 `Content-Disposition: attachment` with UTF-8 Hebrew filename. Audit row `project.export` written per call. Query: `?format=xlsx|pdf` (default xlsx).',
    response:
      '(binary xlsx or pdf — Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | application/pdf; Content-Disposition: attachment; filename="<ascii-slug>.<ext>"; filename*=UTF-8\'\'<%-encoded>)',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
      'http_429',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/notifications',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List the CALLER’S OWN notifications, cursor-paginated (locked RLS: user_id = app.user_id).',
    request: ListNotificationsQuery,
    response:
      '{ "data": [ {Notification} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/notifications/read-all',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Mark all of the caller’s unread notifications read.',
    response: '{ "data": { "updated": int } }',
    errors: ['missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/notifications/:id/read',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Mark one of the caller’s notifications read (idempotent).',
    response: '{ "data": { ...Notification } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/notes',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List org notes, cursor-paginated. Agent → own / org-level / assigned-project notes only.',
    request: ListNotesQuery,
    response:
      '{ "data": [ {Note} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/notes',
    auth: 'AuthGuard + TenantGuard (Manager/Agent)',
    summary: 'Create a note (optionally on a visible project/apartment). Viewer forbidden.',
    request: CreateNoteInput,
    response: '{ "data": { ...Note } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/notes/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one note (org-scoped; Agent → own/assigned/org-level only).',
    response: '{ "data": { ...Note } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/notes/:id',
    auth: 'AuthGuard + TenantGuard (Manager or author)',
    summary: 'Update body/pinned. Manager or the note author only.',
    request: UpdateNoteInput,
    response: '{ "data": { ...Note } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/notes/:id',
    auth: 'AuthGuard + TenantGuard (Manager or author)',
    summary: 'Soft delete (archivedAt — "ארכוב"). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/audit',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Read the org audit trail (append-only), cursor-paginated. Manager only; who/what/target/when (no diffs/ip/ua).',
    request: ListAuditQuery,
    response:
      '{ "data": [ {AuditEntry} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'forbidden',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/projects/:projectId/assignments',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List a project’s active assignments (D.17 linchpin). Agent → only their own rows. Via-parent isolation.',
    request: ListProjectAssignmentsQuery,
    response:
      '{ "data": [ {ProjectAssignment} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/projects/:projectId/assignments',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Assign an org member to the project (powers Agent scoping). Unique active (project,user) → assignment_exists.',
    request: CreateProjectAssignmentInput,
    response: '{ "data": { ...ProjectAssignment } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'invalid_assignee',
      'assignment_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/assignments/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Unassign (unassignedAt — lifecycle, not physical delete). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/members',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'List org memberships (pending + active), cursor-paginated. Manager only.',
    request: ListMembersQuery,
    response:
      '{ "data": [ {Member} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'forbidden',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/members',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Invite a user into the org with a role (atomic user+membership, withBootstrap-scoped). Returns a one-time invite token (email deferred). Manager only.',
    request: CreateMemberInput,
    response: '{ "data": { "member": { ...Member }, "inviteToken": "<jwt>" } }',
    errors: [
      'validation_error',
      'forbidden',
      'member_exists',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/members/:userId',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: "Change a member's role. Manager only. Cannot modify self (lockout guard).",
    request: UpdateMemberInput,
    response: '{ "data": { ...Member } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'cannot_modify_self',
      'cannot_remove_last_manager',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/members/:userId',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary: 'Revoke a membership (revokedAt). Manager only. Cannot revoke self. 204.',
    response: '(204 No Content)',
    errors: [
      'forbidden',
      'not_found',
      'cannot_modify_self',
      'cannot_remove_last_manager',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/accept-invite',
    auth: 'Public (one-time invite token)',
    summary:
      'Invitee sets their OWN password via the one-time invite token (single-use). Generic invalid_invite on any failure (no oracle).',
    request: AcceptInviteInput,
    response: '{ "data": { "ok": true } }',
    errors: ['validation_error', 'invalid_invite', '429'],
  },

  // ── Imports (Phase 6 / D.34 / v7 audit Agent A HIGH-2) ─────────
  // The Excel-import wizard endpoints. All Manager-only (CASL: subject
  // 'imports', action 'create'/'read'/'update'/'delete'). The SSE
  // stream emits ImportSseEvent frames (discriminated union in
  // @emapp/shared-types — progress | end | gone).
  {
    method: 'POST',
    path: '/api/v1/imports',
    auth: 'Manager',
    summary:
      'Create an import row + return a short-lived presigned PUT URL. Step 1 of 2 (step 2 is /start after the FE uploads to R2). 50MB hard cap; sha256 content-hash required.',
    request: CreateImportInput,
    response:
      '{ "data": { "import": ImportJob, "uploadUrl": "https://…", "uploadExpiresInSeconds": 300 } }',
    errors: ['validation_error', 'forbidden', 'not_found', 'import_conflict', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/imports/:id/start',
    auth: 'Manager (creator only)',
    summary:
      'Enqueue the worker job AFTER the upload completes. Pre-flights a 500ms-bounded R2 head() to catch upload_size_mismatch fast; the worker is the safety net.',
    request: StartImportInput,
    response: '{ "data": ImportJob }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'import_not_startable',
      'upload_size_mismatch',
      '429',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/imports/:id',
    auth: 'Manager',
    summary: 'Read the current import row (status + row counters).',
    response: '{ "data": ImportJob }',
    errors: ['not_found'],
  },
  {
    method: 'DELETE',
    path: '/api/v1/imports/:id',
    auth: 'Manager',
    summary:
      'Cancel a non-terminal import. Wins races with the worker via guarded UPDATEs (status = expected) — terminal rows reject with import_not_cancellable.',
    response: '204 No Content',
    errors: ['forbidden', 'not_found', 'import_not_cancellable'],
  },
  {
    method: 'GET',
    path: '/api/v1/imports/:id/errors',
    auth: 'Manager',
    summary:
      'Paginated keyset listing of per-row validation failures (worker validateStage). PII already scrubbed at write-time; messages length-capped at 500 chars.',
    request: ListImportErrorsQuery,
    response: '{ "data": ImportError[], "page": { "limit", "cursor", "has_more" } }',
    errors: ['validation_error', 'not_found', 'invalid_cursor'],
  },
  {
    method: 'POST',
    path: '/api/v1/imports/:id/mapping',
    auth: 'Manager',
    summary:
      'D.34 wizard — submit a column mapping for a row in awaiting_mapping. Stores a mapping_template (org-scoped) and re-enqueues the worker.',
    request: SubmitMappingInput,
    response: '{ "data": { "import": ImportJob, "templateId": "<uuid>" } }',
    errors: ['validation_error', 'forbidden', 'not_found', 'import_not_in_awaiting_mapping'],
  },
  // ── Provider Admin BE (D.37 / Phase 6.5) ───────────────────────
  // Read-only surface for the EMAPP ops team. Tier-isolated:
  // ProviderAuthGuard (JWT audience 'emapp-provider', D.29) +
  // ProviderAuthorizationGuard (PROVIDER_POLICY matrix). Every call
  // requires `access_reason` header (400 reason_required if missing)
  // and writes a provider_audit_log row. PII is masked even at the
  // Provider tier (national_id NEVER on wire; name/phone bullet-masked).
  // Gate-6: any write requires a separate D.NN entry before code review
  // accepts it — this surface stays GET-only by design.
  {
    method: 'GET',
    path: '/api/v1/provider/tenants',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard',
    summary:
      'List orgs (cross-tenant, BYPASSRLS via withProvider), cursor-paginated. Counts (users / projects / owners) inlined via correlated subqueries. No PII.',
    request: ListTenantsQuerySchema,
    response:
      '{ "data": [ {TenantListItem} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'reason_required',
      'missing_token',
      'invalid_token',
      'token_expired',
      'session_revoked',
      'forbidden',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/provider/tenants/:id',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard',
    summary:
      'Tenant detail + extended counts + up to 5 sample owners (PII masked in-SQL: name `•••••••XX`, phone `•••••XXXX`; national_id NEVER returned).',
    response: '{ "data": { ...TenantDetail (masked) } }',
    errors: [
      'reason_required',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
      'session_revoked',
      'forbidden',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/provider/audit',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard',
    summary:
      'Cross-tenant audit_log search (orgId / action prefix / date range / cursor). action regex `^[a-z][a-z0-9_.-]*$`; LIKE wildcards rejected at Zod.',
    request: ProviderAuditQuerySchema,
    response:
      '{ "data": [ {ProviderAuditItem} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
      'reason_required',
      'missing_token',
      'invalid_token',
      'token_expired',
      'session_revoked',
      'forbidden',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/provider/system-health',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard',
    summary:
      'Read-only gauges for the ops dashboard. Leaves are numbers / Date / null only — structurally no PII surface (proven by recursive leaf-type scan in spec).',
    response: '{ "data": { queue:{}, pool:{ app:{}, provider:{} }, r2:{}, timestamp } }',
    errors: [
      'reason_required',
      'missing_token',
      'invalid_token',
      'token_expired',
      'session_revoked',
      'forbidden',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/imports/:id/stream',
    auth: 'Manager',
    summary:
      'Server-Sent Events stream of import progress. Frames are ImportSseEvent (discriminated on `event` ∈ progress | end | gone). Heartbeat comment every 15s defeats proxy idle timeouts. Closes on terminal state, on 404 (gone), or on client abort.',
    response:
      'text/event-stream; one ImportSseEvent JSON object per `data:` line (see @emapp/shared-types#ImportSseEventSchema)',
    errors: ['forbidden', 'not_found'],
  },
];

// §2 global error catalogue (FE switches on error.code, never on message).
const ERROR_CATALOG: Array<[string, string, string]> = [
  ['validation_error', '400', 'Zod DTO rejected the body. details carries field errors.'],
  ['invalid_credentials', '401', 'Bad email/password/MFA OR locked (silent, anti-enum).'],
  ['missing_token', '401', 'No access token cookie/bearer on a guarded route.'],
  ['invalid_token', 'token_expired', '401', 'JWT bad/expired/wrong-tier (HS256+iss+aud pinned).'],
  ['session_revoked', '401', 'Session logged out / reuse-purged — immediate revoke.'],
  ['missing_refresh_token', '401', 'No refresh cookie on the refresh endpoint.'],
  ['invalid_refresh', '401', 'Refresh token unknown/expired/rotated/replayed.'],
  ['invalid_otp', '401', 'Tenant OTP wrong/expired/used/attempts-exhausted (generic).'],
  ['not_member', '401', 'switch-org target is not an active membership.'],
  ['forbidden', '403', 'Authenticated but role lacks permission (D.17 — e.g. non-Manager write).'],
  ['not_found', '404', 'Resource absent OR outside the caller’s org/assignment (no oracle).'],
  ['invalid_cursor', '400', 'Pagination cursor tampered/garbage — never a 500.'],
  ['invalid_json', '400', 'Body is not valid JSON (parser-level; never a 500).'],
  ['bad_request', '400', 'Malformed request rejected before the handler (carried 4xx).'],
  [
    'idempotency_conflict',
    '409',
    'Same Idempotency-Key is still in-flight (concurrent duplicate). Retry later.',
  ],
  ['member_exists', '409', 'That email already has an active membership in this org.'],
  ['cannot_modify_self', '400', 'A manager cannot change/revoke their own membership.'],
  ['cannot_remove_last_manager', '400', 'Would leave the org with zero usable managers.'],
  ['invalid_invite', '400', 'Invite token bad/expired/used or wrong membership (generic).'],
  [
    'owner_exists',
    '409',
    'Same-org duplicate national_id (not an enumeration oracle — caller is in-org).',
  ],
  [
    'ownership_sum_invalid',
    '400',
    'Apartment active ownership shares must be empty or sum to exactly 100.',
  ],
  ['contractor_exists', '409', 'Same-org duplicate contractor contactEmail (active).'],
  ['contractor_invalid', '400', 'Share grant references a non-existent / archived contractor.'],
  ['share_exists', '409', 'That contractor already has an active share on this project.'],
  ['invalid_assignee', '400', 'Task assignee is not an active member of the org.'],
  ['assignee_exists', '409', 'That user is already assigned to the task.'],
  ['assignment_exists', '409', 'That user already has an active assignment on this project.'],
  [
    'reason_required',
    '400',
    'Provider Admin endpoint called without the `access_reason` header (D.37). 5-512 chars after control-char strip.',
  ],
  ['429', '429', 'Per-IP throttle exceeded (signup/login dedicated limits).'],
  ['500', '500', 'Unexpected. Generic body; cause logged server-side only.'],
];

function fieldsTable(schema: ZodTypeAny): string {
  const js = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const props = js.properties ?? {};
  const required = new Set(js.required ?? []);
  const names = Object.keys(props).sort();
  if (names.length === 0) return '_(no body)_\n';
  let out = '| field | type | required | constraints |\n|---|---|---|---|\n';
  for (const n of names) {
    const p = props[n] ?? {};
    const type = String(p['type'] ?? p['format'] ?? 'unknown');
    const c: string[] = [];
    for (const k of ['minLength', 'maxLength', 'format', 'pattern', 'enum', 'minimum', 'maximum']) {
      if (p[k] !== undefined) c.push(`${k}=${JSON.stringify(p[k])}`);
    }
    out += `| \`${n}\` | ${type} | ${required.has(n) ? 'yes' : 'no'} | ${c.join(', ') || '—'} |\n`;
  }
  return out;
}

function render(): string {
  const lines: string[] = [
    '# EMAPP API Reference — Part 3 (GENERATED)',
    '',
    '> Auto-generated by `apps/api/scripts/gen-api-docs.ts` from the Zod',
    '> request schemas (Doc 09 §1.4). DO NOT EDIT BY HAND. Code wins over',
    '> docs — this is derived from the code. Run `pnpm --filter @emapp/api',
    '> gen:api-docs` after changing any auth DTO.',
    '',
    '## Endpoints',
    '',
  ];
  // Codepoint sort (NOT localeCompare — that is locale-dependent and ordered
  // endpoints differently on Windows vs the CI Linux runner → false STALE).
  const key = (e: Endpoint): string => e.path + ' ' + e.method;
  for (const e of [...ENDPOINTS].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))) {
    lines.push(`### ${e.method} ${e.path}`);
    lines.push('');
    lines.push(`- **Auth:** ${e.auth}`);
    lines.push(`- **Summary:** ${e.summary}`);
    lines.push('');
    lines.push('**Request body**');
    lines.push('');
    lines.push(e.request ? fieldsTable(e.request) : '_(no body)_');
    lines.push('');
    lines.push('**Response**');
    lines.push('');
    lines.push('```json');
    lines.push(e.response);
    lines.push('```');
    lines.push('');
    lines.push(`**Errors:** ${e.errors.map((c) => `\`${c}\``).join(', ')}`);
    lines.push('');
  }
  lines.push('## Part 2 — Global error catalogue');
  lines.push('');
  lines.push('| error.code | HTTP | cause |');
  lines.push('|---|---|---|');
  for (const [code, http, cause] of ERROR_CATALOG) {
    lines.push(`| \`${code}\` | ${http} | ${cause} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const OUT = join(process.cwd(), '..', '..', 'docs', '09-api-reference.generated.md');
const generated = render();
const check = process.argv.includes('--check');

// Newline-insensitive: a Windows checkout (CRLF) vs the LF the script emits
// must NOT read as "stale" — content equality is what matters, not EOL.
const norm = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\s*$/, '');

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing → treated as stale */
  }
  if (norm(current) !== norm(generated)) {
    const a = norm(current).split('\n');
    const b = norm(generated).split('\n');
    const diff: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length) && diff.length < 24; i += 1) {
      if (a[i] !== b[i]) {
        diff.push(
          `L${i + 1}\n  committed: ${JSON.stringify(a[i])}\n  generated: ${JSON.stringify(b[i])}`,
        );
      }
    }
    process.stderr.write(
      'docs/09-api-reference.generated.md is STALE — run `pnpm --filter @emapp/api gen:api-docs` and commit.\n' +
        `(${a.length} vs ${b.length} lines) first diffs:\n${diff.join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('API docs up to date.\n');
  process.exit(0);
}

writeFileSync(OUT, generated, 'utf8');
process.stdout.write(`Wrote ${OUT}\n`);
