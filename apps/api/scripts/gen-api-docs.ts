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
  CreateExternalShareInput,
  ExtendExternalShareInput,
  ListExternalSharesQuery,
  UpdateExternalShareInput,
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
  StepUpVerifySchema,
  OwnerSearchInput,
  OwnerEraseInput,
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
  // V12 coverage closure — every controller route documented (enforced by
  // src/architecture/api-docs-coverage.spec.ts).
  ApplyCapabilityPresetInput,
  AssignRoleInput,
  BulkCreateSignatureRequestInput,
  ClearMemberOverrideInput,
  CreateCustomRoleInput,
  CreateDiscoveryRecordInput,
  CreateDocumentInput,
  CreateSignatureRequestInput,
  CreateTabuExtractionInput,
  DownloadDocumentQuery,
  FinalizeDocumentInput,
  ListDocumentsQuery,
  ListImportsQuery,
  ListSignatureRequestsQuery,
  ListTenantUsersQuerySchema,
  OnboardOrgBodySchema,
  OrgSettingsPatchSchema,
  PortalUpdateContactSchema,
  ProviderSelfAuditQuerySchema,
  PublicSignSubmitInput,
  RevokeRoleInput,
  SetMemberOverrideInput,
  SignatureCampaignInput,
  SuspendTenantBodySchema,
  UpdateAgentCapabilitiesInput,
  UpdateCustomRoleInput,
  UpdateDiscoveryRecordInput,
  UpdateDocumentInput,
  // S7c — tabu review+confirm loop.
  UpdateTabuExtractionRowInput,
  // P3a — parcel-setup envelope + manual path → skeleton.
  CreateParcelSetupInput,
  UpdateParcelSetupPayloadInput,
  // Team messaging — member ↔ member conversations.
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageInput,
} from '@emapp/shared-types';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { ForgotPasswordSchema } from '../src/modules/auth/dto/forgot-password.dto';
import { LoginSchema, OrgSwitchSchema } from '../src/modules/auth/dto/login.dto';
import { ResetPasswordSchema } from '../src/modules/auth/dto/reset-password.dto';
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
    path: '/api/v1/auth/step-up/request',
    auth: 'AuthGuard',
    summary:
      'Request a PII step-up OTP (7b-OTP, D-P5.5). 6-digit code emailed to the caller; ' +
      'hashed at rest; 3/15min rate limit (the 4th in-window request sends no email).',
    response:
      '{ "data": { "ok": true } }  (dev/QA ONLY — EXPOSE_STEP_UP_CODE=true + NODE_ENV ' +
      'development|test, read at request time — adds "code": "123456"; fail-closed in production)',
    errors: ['missing_token', 'invalid_token', 'token_expired', 'invalid_session', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/step-up/verify',
    auth: 'AuthGuard',
    summary:
      'Verify the step-up OTP → stamp pii_unlocked_at on the CALLER’S CURRENT session only ' +
      '(unlocks sensitive-document downloads for security.piiUnlockTtlMinutes, default 60).',
    request: StepUpVerifySchema,
    response: '{ "data": { "ok": true } }',
    errors: ['validation_error', 'missing_token', 'invalid_token', 'invalid_step_up_code', '429'],
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
    summary:
      'Partial update. Manager only. Every field optional. E2 Wave-1 B5: `status` changes are gated by a state machine (planning→{gathering_signatures,cancelled}; gathering_signatures→{approved,cancelled}; approved→{in_construction,cancelled}; in_construction→{completed,cancelled}; completed/cancelled terminal); a `→approved` transition additionally requires the share-weighted consent `metThreshold`. Optional `expectedUpdatedAt` (the last-read `updated_at`) enables optimistic concurrency — a stale value → `stale_write` 409. The response carries the new `updated_at` for chaining.',
    request: UpdateProjectInput,
    response: '{ "data": { ...Project } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'invalid_status_transition',
      'threshold_not_met',
      'stale_write',
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
    method: 'GET',
    path: '/api/v1/owners/:id/data-export',
    auth: 'AuthGuard + TenantGuard (Manager · owners.reveal_pii)',
    summary:
      'P0.C1 — data-subject ACCESS (right to access). Assembles EVERYTHING held about the owner (decrypted PII + ownerships + signature events). Manager-tier; audited as a PII reveal.',
    response: '{ "data": { ...OwnerDataExport (CLEARTEXT) } }',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/owners/:id/erase',
    auth: 'AuthGuard + TenantGuard (Manager · owners.reveal_pii)',
    summary:
      'P0.C1 — data-subject ERASURE (right-to-be-forgotten). Crypto-shreds PII in place (anonymize-not-delete); RETAINS signature/ownership rows for legal validity. Idempotent. Manager-tier; audited; Gate-6.',
    request: OwnerEraseInput,
    response: '{ "data": { ...OwnerErasureResult } }',
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
  // X-S2/X-S3 (V13) — generalized party-typed external_share grants.
  {
    method: 'GET',
    path: '/api/v1/external-shares',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List ACTIVE external_share grants for the org, cursor-paginated. Optional ?partyType filter. Suspended org → empty (inert). RLS org isolation.',
    request: ListExternalSharesQuery,
    response:
      '{ "data": [ {ExternalShare} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/external-shares',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Create a party-typed external grant. Server re-validates scope_type + permissions + allow_sensitive + TTL against the party preset CEILING (fail-closed, narrows-only). scope_ids must resolve in-org.',
    request: CreateExternalShareInput,
    response: '{ "data": { ...ExternalShare } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'exceeds_ceiling',
      'invalid_scope',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/external-shares/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Update an active grant. NARROWS-ONLY: rejects any widening beyond the party ceiling OR the grant current footprint (scope/permissions/sensitive/otp).',
    request: UpdateExternalShareInput,
    response: '{ "data": { ...ExternalShare } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'exceeds_ceiling',
      'cannot_widen',
      'invalid_scope',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/external-shares/:id/extend',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Push expires_at FORWARD only, capped at the party ceiling TTL from now. Refuses to shorten via extend.',
    request: ExtendExternalShareInput,
    response: '{ "data": { ...ExternalShare } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'not_forward',
      'exceeds_ceiling',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/external-shares/:id/resend',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Audited re-issue marker (bumps updated_at + logs). The OTP-access + delivery channel is X-S4. Suspended/missing/revoked → 404.',
    response: '{ "data": { ...ExternalShare } }',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'DELETE',
    path: '/api/v1/external-shares/:id',
    auth: 'AuthGuard + TenantGuard (Manager)',
    summary:
      'Revoke the grant (revoked_at + revoked_by — immediate, no physical delete). Idempotent. 204.',
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
  // ─── Team messaging — member ↔ member conversations (participation-based
  // authz: AuthGuard + TenantGuard + RLS participant scoping; NOT the IAM
  // matrix). Viewer is read-only (cannot create a thread or send). ───────────
  {
    method: 'GET',
    path: '/api/v1/conversations',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List the caller’s conversations (RLS participant-scoped), cursor-paginated by recency, with participant ids, last-message preview, and unread count.',
    request: ListConversationsQuery,
    response:
      '{ "data": [ {Conversation} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/conversations',
    auth: 'AuthGuard + TenantGuard (Manager/Agent)',
    summary:
      'Start a conversation with one or more active org members (creator added automatically); optional first message. Viewer forbidden.',
    request: CreateConversationInput,
    response: '{ "data": { ...Conversation } }',
    errors: [
      'validation_error',
      'invalid_participant',
      'forbidden',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/conversations/:id',
    auth: 'AuthGuard + TenantGuard',
    summary: 'Get one conversation the caller participates in (no-oracle 404 otherwise).',
    response: '{ "data": { ...Conversation } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/conversations/:id/messages',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'List messages in a conversation the caller participates in, cursor-paginated (newest first). No-oracle 404 if not a participant.',
    request: ListMessagesQuery,
    response:
      '{ "data": [ {Message} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/conversations/:id/messages',
    auth: 'AuthGuard + TenantGuard (Manager/Agent)',
    summary:
      'Send a message into a conversation the caller participates in (DB WITH CHECK enforces participant-only post). Viewer forbidden; no-oracle 404 if not a participant.',
    request: SendMessageInput,
    response: '{ "data": { ...Message } }',
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
    method: 'POST',
    path: '/api/v1/conversations/:id/read',
    auth: 'AuthGuard + TenantGuard',
    summary:
      'Mark the conversation read up to now (sets the caller’s last_read_at). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
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

  // ── V12 coverage closure (2026-06-12) ──────────────────────────
  // Every entry below mirrors a REAL controller route that predated the
  // coverage guard (src/architecture/api-docs-coverage.spec.ts). Routing
  // facts verified against the controllers; error codes against the services.

  // — Auth: password reset (P1 R0.1) —
  {
    method: 'POST',
    path: '/api/v1/auth/forgot-password',
    auth: 'Public',
    summary:
      'Request a password-reset email. ALWAYS the same generic 200 (anti-enumeration); 5 / 15 min / IP throttle; per-email abuse capped in the repository.',
    request: ForgotPasswordSchema,
    response: '{ "data": { "ok": true, "message": "<generic Hebrew — never reveals existence>" } }',
    errors: ['validation_error', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/auth/reset-password',
    auth: 'Public (one-time reset token)',
    summary:
      'Consume the 256-bit single-use reset token + set the new password (argon2id). Generic invalid_reset_token on any failure (no oracle). 10 / 15 min / IP.',
    request: ResetPasswordSchema,
    response: '{ "data": { "ok": true } }',
    errors: ['validation_error', 'invalid_reset_token', '429'],
  },

  // — Org dashboard + settings —
  {
    method: 'GET',
    path: '/api/v1/org/stats',
    auth: 'AuthGuard + TenantGuard (projects.read)',
    summary:
      'Org-wide aggregate KPI stats for the home dashboard (counts only, no PII). All org roles.',
    response: '{ "data": { ...OrgStats } }',
    errors: ['missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/org/signature-pulse',
    auth: 'AuthGuard + TenantGuard (projects.read)',
    summary:
      'E2 Wave-2 B1 — org-wide signature-pulse feed for the board-first home: per-project attention rows (rankAttention-ordered), needsHuman bucket, header buckets. Agent → assigned projects only; manager/viewer → whole org. Single-source share-weighted consent (matches the board). No PII (counts/%/timestamps only).',
    response: '{ "data": { ...SignaturePulse } }',
    errors: ['missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/org/settings',
    auth: 'AuthGuard + TenantGuard (org.settings.read — Owner/Admin)',
    summary:
      'P6-1 — read the resolved per-org settings (organizations.settings JSONB seam). org.* governance permission — Manager does NOT hold it.',
    response: '{ "data": { ...OrgSettings } }',
    errors: ['forbidden', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/org/settings',
    auth: 'AuthGuard + TenantGuard (org.settings.update — Owner/Admin)',
    summary:
      'P6-1 — partial update of the org settings (unknown-key-strict). Floor violations (loosening below the security floor) rejected.',
    request: OrgSettingsPatchSchema,
    response: '{ "data": { ...OrgSettings } }',
    errors: [
      'validation_error',
      'forbidden',
      'org_settings_floor_violation',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },

  // — Projects: signature-progress board + campaign —
  {
    method: 'GET',
    path: '/api/v1/projects/:id/signature-progress',
    auth: 'AuthGuard + TenantGuard (projects.read)',
    summary:
      'Phase-6 "תמונת מצב" — aggregate signature-progress board (read-only). Service owns visibility (no-oracle 404 for cross-org / unassigned-agent).',
    response: '{ "data": { ...SignatureProgress (counts, no PII) } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/projects/:id/signature-progress/apartments',
    auth: 'AuthGuard + TenantGuard (projects.read)',
    summary:
      'S5d — per-apartment signature-progress DRILL-DOWN (read-only). Apartment designation + counts + derived status; NO owner PII.',
    response: '{ "data": [ {ApartmentSignatureProgress} ] }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/projects/:id/signature-progress/apartments/:apartmentId/holdouts',
    auth: 'AuthGuard + TenantGuard (projects.read; FINE view_owner_pii capability gate in service)',
    summary:
      'E2 Wave-2 B4 — apartment HOLDOUTS ("מי תקוע / who\'s stuck"): the NAMED list of the apartment\'s active owners who have NOT signed. The ONLY signature-progress surface returning owner NAMES → view_owner_pii-gated + audited per access (ISO A.12.4), mirroring owners reveal-pii. No-oracle 404 for cross-org / unassigned-agent / apartment-not-in-project. Returns ownerId + name + apartmentNumber ONLY; NEVER national_id/phone.',
    response: '{ "data": { "holdouts": [ {ApartmentHoldout: ownerId, name, apartmentNumber} ] } }',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/projects/:id/signature-campaign',
    auth: 'AuthGuard + TenantGuard (signature_requests.send)',
    summary:
      'S5b — fan out ONE project document to ALL active owners of the project (reuses bulk-send: gate + dedup + delivery). 10/min throttle (email-bomb defense); doc-belongs-to-project enforced.',
    request: SignatureCampaignInput,
    response: '{ "data": { ...CampaignResult (created/skipped counts) } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'document_not_in_project',
      'missing_token',
      'invalid_token',
      'token_expired',
      '429',
    ],
  },

  // — Discovery records (S3c renter → discovery-source) —
  {
    method: 'GET',
    path: '/api/v1/apartments/:apartmentId/discovery-records',
    auth: 'AuthGuard + TenantGuard (apartments.read)',
    summary:
      'List discovery records of an apartment, cursor-paginated. Via-parent isolation; Agent → assigned projects only.',
    request: ListOwnershipsQuery,
    response:
      '{ "data": [ {DiscoveryRecord} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/apartments/:apartmentId/discovery-records',
    auth: 'AuthGuard + TenantGuard (apartments.update; agent fine gate edit_project_data)',
    summary: 'Create a discovery record under an apartment. apartmentId from the URL.',
    request: CreateDiscoveryRecordInput,
    response: '{ "data": { ...DiscoveryRecord } }',
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
    method: 'PATCH',
    path: '/api/v1/discovery-records/:id',
    auth: 'AuthGuard + TenantGuard (apartments.update; agent fine gate edit_project_data)',
    summary: 'Partial update of a discovery record (via-parent org scope).',
    request: UpdateDiscoveryRecordInput,
    response: '{ "data": { ...DiscoveryRecord } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },

  // — Tabu extractions (S7a/S7b) —
  {
    method: 'GET',
    path: '/api/v1/apartments/:apartmentId/tabu-extractions',
    auth: 'AuthGuard + TenantGuard (apartments.read)',
    summary:
      'List tabu extractions of an apartment, cursor-paginated. Via-parent isolation; Agent → assigned projects only.',
    request: ListOwnershipsQuery,
    response:
      '{ "data": [ {TabuExtraction} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/apartments/:apartmentId/tabu-extractions',
    auth: 'AuthGuard + TenantGuard (apartments.update; agent fine gate edit_project_data)',
    summary:
      'Create a tabu-extraction envelope for an apartment. Source document must be FINALIZED and apartment-scoped.',
    request: CreateTabuExtractionInput,
    response: '{ "data": { ...TabuExtraction } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'tabu_source_not_finalized',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/tabu-extractions/:id',
    auth: 'AuthGuard + TenantGuard (apartments.read)',
    summary: 'Get one tabu extraction by id (via-parent org scope; Agent → assigned only).',
    response: '{ "data": { ...TabuExtraction } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/tabu-extractions/:id/extract',
    auth: 'AuthGuard + TenantGuard (apartments.update; D.54 agent fine gate)',
    summary:
      'S7b — run the extraction engine over the finalized source document; persists tabu_extraction_rows. No body.',
    response: '{ "data": { "rowCount": int, "engineId": "string" } }',
    errors: [
      'forbidden',
      'not_found',
      'tabu_source_not_finalized',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/tabu-extractions/:id/rows',
    auth: 'AuthGuard + TenantGuard (apartments.read; VALID per-session PII unlock REQUIRED)',
    summary:
      'S7c — the DECRYPTED parsed rows for the review screen. 403 pii_step_up_required without a ' +
      'valid unlock (pii_unlocked_at + security.piiUnlockTtlMinutes, default 60); national_id is ' +
      '•-masked for callers with masked owner-PII fidelity (D.19/D.47/D.54). Reveal is audited.',
    response:
      '{ "data": [ { "id": uuid, "name": "string|null", "nationalId": "string|null", ' +
      '"shareNumerator": int|null, "shareDenominator": int|null, "confidence": number|null, ' +
      '"edited": bool, "position": int } ] }',
    errors: [
      'pii_step_up_required',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/tabu-extractions/:id/rows/:rowId',
    auth:
      'AuthGuard + TenantGuard (apartments.update; PII unlock REQUIRED + D.54 agent fine gate ' +
      'edit_project_data)',
    summary:
      'S7c — edit one parsed row before confirm: PII re-encrypted (pgcrypto), edited=true. ' +
      'DRAFT-only (409 tabu_extraction_not_draft).',
    request: UpdateTabuExtractionRowInput,
    response: '{ "data": { "ok": true } }',
    errors: [
      'validation_error',
      'pii_step_up_required',
      'forbidden',
      'not_found',
      'tabu_extraction_not_draft',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/tabu-extractions/:id/confirm',
    auth:
      'AuthGuard + TenantGuard (apartments.update; PII unlock REQUIRED + D.54 agent fine gate ' +
      'edit_project_data)',
    summary:
      'S7c — THE commit: audit-first, IDEMPOTENT (WHERE status=draft; second confirm → 409), ' +
      'atomic — owners matched by national_id hash or created as shells, the apartment’s active ' +
      'ownerships REPLACED with the confirmed fractions (deferred sum trigger = 1 at COMMIT), ' +
      'source_extraction_id stamped on every written row. No body.',
    response: '{ "data": { ...TabuExtraction } }  (status=confirmed, confirmedAt set)',
    errors: [
      'pii_step_up_required',
      'forbidden',
      'not_found',
      'tabu_extraction_not_draft',
      'tabu_rows_incomplete',
      'ownership_sum_invalid',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },

  // — Parcel setups (P3a — envelope + manual path → skeleton) —
  {
    method: 'POST',
    path: '/api/v1/projects/:projectId/parcel-setups',
    auth: 'AuthGuard + TenantGuard (buildings.create; D.54 agent fine gate edit_project_data)',
    summary:
      'P3a — create a parcel-setup (גוש-חלקה) draft envelope on an EXISTING project. ' +
      'Project visibility is no-oracle 404. P3b — after the draft insert the pluggable ' +
      'parcel-data provider (PARCEL_LOOKUP_ENABLED → LocalMapi, else zero-egress Stub) is ' +
      'consulted with ONLY block/parcel/sub (zero-PII egress): found → source=the provider ' +
      'id (never from the DTO) + providerCity + providerStatus=found; not-found/Stub/provider ' +
      'error → FAIL-OPEN: draft stands, source=manual, providerStatus=not_found.',
    request: CreateParcelSetupInput,
    response:
      '{ "data": { ...ParcelSetup } }  (status=draft, payload=null; source=manual|"local-mapi", ' +
      'providerStatus="found"|"not_found", providerCity=string|null)',
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
    path: '/api/v1/projects/:projectId/parcel-setups',
    auth: 'AuthGuard + TenantGuard (buildings.read)',
    summary:
      'List parcel setups of a project, cursor-paginated. Org-scoped (FORCE RLS); ' +
      'Agent → assigned projects only.',
    request: ListOwnershipsQuery,
    response:
      '{ "data": [ {ParcelSetup} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/parcel-setups/:id',
    auth: 'AuthGuard + TenantGuard (buildings.read)',
    summary: 'Get one parcel setup by id (org scope no-oracle 404; Agent → assigned only).',
    response: '{ "data": { ...ParcelSetup } }  (P3b: wire includes providerStatus + providerCity)',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/parcel-setups/:id',
    auth: 'AuthGuard + TenantGuard (buildings.update; D.54 agent fine gate edit_project_data)',
    summary:
      'P3a — save the draft buildings/apartments payload. DRAFT-only (409 ' +
      'parcel_setup_not_draft). STRICT no-PII Zod at every level (unknown keys like ' +
      'ownerName/nationalId/phone are rejected); re-parsed in the service (defense-in-depth).',
    request: UpdateParcelSetupPayloadInput,
    response: '{ "data": { ...ParcelSetup } }  (payload persisted)',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'parcel_setup_not_draft',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/parcel-setups/:id/confirm',
    auth: 'AuthGuard + TenantGuard (buildings.create; D.54 agent fine gate edit_project_data)',
    summary:
      'P3a — THE manual-path commit: audit-first (ids+counts only — never addresses), ' +
      'IDEMPOTENT single-claim (WHERE status=draft; second confirm → 409), ATOMIC — creates the ' +
      'buildings (stamped source_parcel_setup_id) + their apartments under the project. A ' +
      'unique-collision with the existing skeleton → clean 409 parcel_skeleton_conflict with ' +
      'FULL rollback (setup stays draft, no orphan audit). No body.',
    response: '{ "data": { ...ParcelSetup } }  (status=confirmed, confirmedAt set)',
    errors: [
      'forbidden',
      'not_found',
      'parcel_payload_missing',
      'parcel_setup_not_draft',
      'parcel_skeleton_conflict',
      'validation_error',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },

  // — Documents (slice-5a engine-gated; fine gate manage_documents in service) —
  {
    method: 'GET',
    path: '/api/v1/documents',
    auth: 'AuthGuard + TenantGuard (documents.read)',
    summary:
      'List org documents, cursor-paginated. Doc/project visibility scoping in the service; r2Key never returned.',
    request: ListDocumentsQuery,
    response:
      '{ "data": [ {Document} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/documents',
    auth: 'AuthGuard + TenantGuard (documents.create; agent fine gate manage_documents)',
    summary:
      'Create a document row + return a short-lived presigned PUT URL (presign-after-authorize). 30/min throttle. ' +
      '7d: a SENSITIVE doc (id_document/financial by type, or sensitive:true) gets NO presigned PUT — uploadUrl is null and ' +
      'contentUploadPath points at POST /documents/:id/content (the API-side encrypted upload path).',
    request: CreateDocumentInput,
    response:
      '{ "data": { "document": { ...Document }, "uploadUrl": "https://…|null", "contentUploadPath": "/api/v1/documents/:id/content (sensitive only)" } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'storage_unavailable',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/documents/:id',
    auth: 'AuthGuard + TenantGuard (documents.read)',
    summary: 'Get one document by id (org-scoped; visibility-scoped in the service).',
    response: '{ "data": { ...Document } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/documents/:id/download',
    auth: 'AuthGuard + TenantGuard (documents.read)',
    summary:
      'Short-lived presigned GET URL for the stored object (?disposition=inline|attachment). 30/min throttle (bulk-exfil defense). ' +
      '7d behavioral note: a bytes_encrypted (sensitive, app-envelope) doc is NOT presigned — the API decrypt-STREAMS the bytes ' +
      'itself (Content-Type = doc mime, Content-Disposition per the disposition param). Same gates either way (visibility/ghost/' +
      'scan + 403 pii_step_up_required without a valid session unlock). Plain docs: byte-identical presign response.',
    request: DownloadDocumentQuery,
    response:
      '{ "data": { "url": "https://…", ... } } — or the raw decrypted bytes (streamed) when the doc is bytes_encrypted',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'storage_unavailable',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/documents/:id/finalize',
    auth: 'AuthGuard + TenantGuard (documents.create; agent fine gate manage_documents)',
    summary:
      'Mark the upload complete after the FE PUT to R2 — integrity-checks the stored object (size/hash) before flipping status.',
    request: FinalizeDocumentInput,
    response: '{ "data": { ...Document } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'document_conflict',
      'document_integrity_mismatch',
      'document_type_mismatch',
      'document_scan_rejected',
      'storage_unavailable',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/documents/:id/content',
    auth: 'AuthGuard + TenantGuard (documents.create; agent fine gate manage_documents)',
    summary:
      '7d — SENSITIVE-only content upload: RAW bytes (application/octet-stream, dedicated 50MB bodyLimit), 30/min throttle. ' +
      'Server verifies sha256+size against the create-declared values (mismatch → 400 document_integrity_mismatch with ' +
      'details.field=size|hash; nothing stored), scans the PLAINTEXT (non-clean → fail-closed archive + 409 ' +
      'document_scan_rejected), encrypts AES-256-GCM into the EMAPPENC app-envelope (DOC_ENCRYPTION_KEY, never in R2) and ' +
      'stores it server-side. Stamps uploaded_at + scan_status=clean + bytes_encrypted=true — no finalize step. ' +
      'Plain docs are rejected (400 document_not_sensitive — presign is their only path).',
    response: '{ "data": { "uploaded": true } }',
    errors: [
      'invalid_content_body',
      'document_not_sensitive',
      'document_already_uploaded',
      'document_integrity_mismatch',
      'document_type_mismatch',
      'document_scan_rejected',
      'forbidden',
      'not_found',
      'storage_unavailable',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/documents/:id',
    auth: 'AuthGuard + TenantGuard (documents.update; agent fine gate manage_documents)',
    summary: 'Partial metadata update (r2Key never accepted).',
    request: UpdateDocumentInput,
    response: '{ "data": { ...Document } }',
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
    path: '/api/v1/documents/:id',
    auth: 'AuthGuard + TenantGuard (documents.archive; agent fine gate manage_documents)',
    summary: 'Soft delete (archivedAt — "ארכוב"). Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },

  // — Imports: list + preview-confirm (post-S11 / 0048) —
  {
    method: 'GET',
    path: '/api/v1/imports',
    auth: 'Manager/Agent/Viewer (imports.read)',
    summary:
      'List org imports, cursor-paginated (read=ALL per D.17; Agent → imports of assigned projects only).',
    request: ListImportsQuery,
    response:
      '{ "data": [ {ImportJob} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: ['validation_error', 'invalid_cursor'],
  },
  {
    method: 'POST',
    path: '/api/v1/imports/:id/confirm',
    auth: 'Manager (imports.map; creator only)',
    summary:
      '0048 preview→confirm — commit a preview-paused import (status=awaiting_confirm): re-queues a full persisting run. 30/min throttle.',
    response: '{ "data": ImportJob }',
    errors: ['forbidden', 'not_found', 'import_not_awaiting_confirm'],
  },

  // — Members: capability governance (D.46 / S4b) + invite resend —
  {
    method: 'GET',
    path: '/api/v1/members/capability-presets',
    auth: 'AuthGuard + TenantGuard (members.read)',
    summary:
      'S4b — the code-defined capability-preset catalog (design §7). Static; carries no per-member data.',
    response: '{ "data": [ {CapabilityPreset} ] }',
    errors: ['forbidden', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/members/:userId/resend',
    auth: 'AuthGuard + TenantGuard (members.invite)',
    summary:
      'Re-issue the invite for a still-PENDING membership (re-mint token + re-send email best-effort; dev returns the link). 5/min throttle (email-bomb defense).',
    response: '{ "data": { "inviteToken"?: "<jwt — dev only>" } }',
    errors: [
      'forbidden',
      'not_found',
      'member_not_pending',
      'missing_token',
      'invalid_token',
      'token_expired',
      '429',
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/members/:userId/capabilities',
    auth: 'AuthGuard + TenantGuard (members.update)',
    summary:
      "D.46 — set an AGENT's capability flags (JSONB). Agent-only target; invariants (e.g. view_owner_pii requires view_owners) enforced + audited in the service.",
    request: UpdateAgentCapabilitiesInput,
    response: '{ "data": { ...Member } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'capabilities_agent_only',
      'view_owner_pii_requires_view_owners',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/members/:userId/apply-capability-preset',
    auth: 'AuthGuard + TenantGuard (members.update)',
    summary:
      'S4b — apply a NAMED capability preset to an agent (delegates to the capabilities update: same gates/invariants/audit).',
    request: ApplyCapabilityPresetInput,
    response: '{ "data": { ...Member } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'unknown_preset',
      'capabilities_agent_only',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },

  // — Member permission overrides (P2 Phase 2 — Owner/Admin governance) —
  {
    method: 'GET',
    path: '/api/v1/members/:userId/overrides',
    auth: 'AuthGuard + TenantGuard (roles.read)',
    summary: "List a member's per-user permission overrides (grant/deny layers).",
    response: '{ "data": [ {MemberOverride} ] }',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'PUT',
    path: '/api/v1/members/:userId/overrides',
    auth: 'AuthGuard + TenantGuard (roles.manage — Owner/Admin; Manager does NOT hold it)',
    summary:
      'Set (upsert) ONE grant/deny override. Anti-escalation + last-Owner guards in the service.',
    request: SetMemberOverrideInput,
    response: '{ "data": { ...MemberOverride } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'unknown_permission',
      'override_escalation',
      'override_owner_tier_only',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/members/:userId/overrides',
    auth: 'AuthGuard + TenantGuard (roles.manage — Owner/Admin)',
    summary: 'Clear one override by its key (key in the BODY). Idempotent. 204.',
    request: ClearMemberOverrideInput,
    response: '(204 No Content)',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },

  // — Notifications: unread-count (M2-perf) —
  {
    method: 'GET',
    path: '/api/v1/notifications/unread-count',
    auth: 'AuthGuard + TenantGuard (self-scoped RLS)',
    summary:
      "Constant-time unread count for the caller's bell (partial index; FE polls ~30s). Own rows only (RLS user_id = app.user_id).",
    response: '{ "data": { "count": int } }',
    errors: ['missing_token', 'invalid_token', 'token_expired'],
  },

  // — Owners: project surfacing + reveal-on-demand (S3d / D.54) —
  {
    method: 'GET',
    path: '/api/v1/owners/:id/projects',
    auth: 'AuthGuard + TenantGuard (owners.read)',
    summary:
      'S3d — the DISTINCT projects the owner is tied to via active ownerships. Lean project list; NO owner PII.',
    response: '{ "data": [ {Project — lean} ] }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/owners/:id/reveal-pii',
    auth: 'AuthGuard + TenantGuard (owners.read; FINE view_owner_pii fidelity gate in service)',
    summary:
      'D.54 — reveal-on-demand CLEARTEXT PII for ONE owner. POST (never in URL/access logs); audited per reveal (ISO A.12.4); 20/min throttle.',
    response: '{ "data": { ...Owner (CLEARTEXT national_id/phone) } }',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },

  // — Tenant Portal (D.40 / V11 B.S4) — own-record-only, SMS-OTP tier —
  {
    method: 'GET',
    path: '/api/v1/portal/me',
    auth: 'TenantAuthGuard (tenant_access cookie, audience emapp-tenant)',
    summary: "The resident's OWN record (masked). Every query scoped to the JWT sub (owner.id).",
    response: '{ "data": { ...own Owner (masked) } }',
    errors: ['missing_token', 'invalid_token', 'session_revoked'],
  },
  {
    method: 'PATCH',
    path: '/api/v1/portal/me',
    auth: 'TenantAuthGuard',
    summary:
      'P4 — resident self-updates OWN contact details (EMAIL only; phone is the OTP factor, national_id immutable — strict schema rejects them). 10 / 10 min throttle.',
    request: PortalUpdateContactSchema,
    response: '{ "data": { ...own Owner (masked) } }',
    errors: ['validation_error', 'missing_token', 'invalid_token', 'session_revoked', '429'],
  },
  {
    method: 'GET',
    path: '/api/v1/portal/apartment',
    auth: 'TenantAuthGuard',
    summary: "The resident's own apartment(s) via active ownerships.",
    response: '{ "data": [ {Apartment} ] }',
    errors: ['missing_token', 'invalid_token', 'session_revoked'],
  },
  {
    method: 'GET',
    path: '/api/v1/portal/documents',
    auth: 'TenantAuthGuard',
    summary: 'Documents visible to the resident (own project scope).',
    response: '{ "data": [ {Document} ] }',
    errors: ['missing_token', 'invalid_token', 'session_revoked'],
  },
  {
    method: 'GET',
    path: '/api/v1/portal/signatures',
    auth: 'TenantAuthGuard',
    summary: "The resident's OWN signature requests (status view; no other resident's data).",
    response: '{ "data": [ {SignatureRequest — own} ] }',
    errors: ['missing_token', 'invalid_token', 'session_revoked'],
  },
  {
    method: 'GET',
    path: '/api/v1/portal/progress',
    auth: 'TenantAuthGuard',
    summary:
      "D2 S5 — AGGREGATE signature progress for the tenant's project(s). Counts only; never another resident's data/PII.",
    response: '{ "data": { ...progress counts } }',
    errors: ['missing_token', 'invalid_token', 'session_revoked'],
  },
  {
    method: 'POST',
    path: '/api/v1/portal/signatures/:id/resend',
    auth: 'TenantAuthGuard',
    summary:
      'B-RESIDENT-1 — resident re-sends THEIR OWN pending signing link to their on-file phone/email. Own-record scoped (no-oracle 404); 3 / 10 min throttle (each call sends an SMS). Returns delivery status only — never the link.',
    response: '{ "data": { ...per-channel delivery status } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'session_revoked', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/portal/logout',
    auth: 'TenantAuthGuard',
    summary:
      'M-1 — tenant-initiated revoke: soft-revokes the tenant session bound to the JWT sid + clears the cookie. Idempotent. 204.',
    response: '(204 No Content)',
    errors: ['missing_token', 'invalid_token', 'session_revoked'],
  },

  // — Contractor portal (D2-DEF-1 / D.46) — share-token tier, read-only —
  {
    method: 'GET',
    path: '/api/v1/contractor/project',
    auth: 'ContractorAuthGuard (share-access token)',
    summary:
      "The shared project's detail. Authority = the share's strict JSONB perms (resolved per-method in the service). 60/min throttle.",
    response: '{ "data": { ...Project } }',
    errors: ['missing_token', 'invalid_token', 'forbidden', 'not_found'],
  },
  {
    method: 'GET',
    path: '/api/v1/contractor/progress',
    auth: 'ContractorAuthGuard (share-access token)',
    summary: 'Aggregate signature progress of the shared project (counts only; share-perm gated).',
    response: '{ "data": { ...progress counts } }',
    errors: ['missing_token', 'invalid_token', 'forbidden', 'not_found'],
  },
  {
    method: 'GET',
    path: '/api/v1/contractor/documents',
    auth: 'ContractorAuthGuard (share-access token)',
    summary: 'Documents of the shared project the share permits (share-perm gated).',
    response: '{ "data": [ {Document} ], "page": { ... } }',
    errors: ['missing_token', 'invalid_token', 'forbidden', 'not_found'],
  },
  {
    method: 'GET',
    path: '/api/v1/contractor/documents/:id/download',
    auth: 'ContractorAuthGuard (share-access token)',
    summary: 'Short-lived presigned GET URL for a share-visible document.',
    response: '{ "data": { "url": "https://…", ... } }',
    errors: ['missing_token', 'invalid_token', 'forbidden', 'not_found', 'storage_unavailable'],
  },

  // — Shares: mint the contractor credential —
  {
    method: 'POST',
    path: '/api/v1/shares/:id/link',
    auth: 'AuthGuard + TenantGuard (shares.create; manager-only in service)',
    summary:
      'D2-DEF-1 — mint a share-access link (the contractor credential) for an existing active share. Audited.',
    response: '{ "data": { ...ShareLink } }',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },

  // — Public signing (T5.6) — the :token JWT IS the credential —
  {
    method: 'GET',
    path: '/api/v1/sign/:token',
    auth: 'Public (signing JWT in the path IS the credential)',
    summary:
      'Resident-facing signing-page preview (document + signer context). 30 / IP / hour. Generic invalid_token on any token failure (no oracle).',
    response: '{ "data": { ...SignPreview } }',
    errors: ['invalid_token', 'storage_unavailable', '429'],
  },
  {
    method: 'POST',
    path: '/api/v1/sign/:token',
    auth: 'Public (signing JWT in the path IS the credential)',
    summary:
      'Submit the signature (SVG, size-capped) + explicit consent. Single-use; signature encrypted at rest (pgcrypto). 5 / IP / hour.',
    request: PublicSignSubmitInput,
    response: '{ "data": { ...SignResult } }',
    errors: [
      'validation_error',
      'invalid_token',
      'consent_required',
      'signature_request_already_signed',
      'encryption_not_configured',
      '429',
    ],
  },

  // — Signature requests (org tier; fine gate manage_signatures in service) —
  {
    method: 'GET',
    path: '/api/v1/signature-requests',
    auth: 'AuthGuard + TenantGuard (signature_requests.read)',
    summary:
      'List signature requests, cursor-paginated. Underlying-document visibility scoping in the service.',
    request: ListSignatureRequestsQuery,
    response:
      '{ "data": [ {SignatureRequest} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/signature-requests',
    auth: 'AuthGuard + TenantGuard (signature_requests.send; agent fine gate manage_signatures)',
    summary:
      'Create + deliver ONE signing request (emails the resident, reserves a 7-day token). The signing JWT is server-minted, only ever returned embedded in signUrl. 30/min throttle.',
    request: CreateSignatureRequestInput,
    response: '{ "data": { ...SignatureRequest } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'recipient_not_associated',
      'signature_request_pending_exists',
      'signature_request_conflict',
      'missing_token',
      'invalid_token',
      'token_expired',
      '429',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/signature-requests/bulk',
    auth: 'AuthGuard + TenantGuard (signature_requests.send; agent fine gate manage_signatures)',
    summary:
      'Bulk send — ONE document to MANY owners (≤200) in one action; per-recipient dedup. 10/min throttle (each call fans out deliveries).',
    request: BulkCreateSignatureRequestInput,
    response: '{ "data": { ...BulkCreateResult (created/skipped) } }',
    errors: [
      'validation_error',
      'forbidden',
      'not_found',
      'missing_token',
      'invalid_token',
      'token_expired',
      '429',
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/signature-requests/:id',
    auth: 'AuthGuard + TenantGuard (signature_requests.read)',
    summary: 'Get one signature request (document-visibility scoped; no-oracle 404).',
    response: '{ "data": { ...SignatureRequest } }',
    errors: ['not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/signature-requests/:id/signed-document',
    auth: 'AuthGuard + TenantGuard (owners.read; FINE PII fidelity gate in service)',
    summary:
      'Download the SIGNED ARTIFACT (signature-certificate PDF: signer + doc hash + signed-at + rendered signature). Carries decrypted owner PII — gate mirrors reveal-pii (manager · agent iff view_owner_pii · viewer never). Binary response, not the {data} envelope.',
    response:
      '(binary — Content-Type from the renderer; Content-Disposition: attachment; Cache-Control: no-store)',
    errors: ['forbidden', 'not_found', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/signature-requests/:id/cancel',
    auth: 'AuthGuard + TenantGuard (signature_requests.cancel; agent fine gate manage_signatures)',
    summary: 'Cancel = state transition (pending → cancelled).',
    response: '{ "data": { ...SignatureRequest } }',
    errors: [
      'forbidden',
      'not_found',
      'signature_request_not_pending',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/signature-requests/:id/resend',
    auth: 'AuthGuard + TenantGuard (signature_requests.send; agent fine gate manage_signatures)',
    summary:
      "Resend / remind — refresh a PENDING request's link (new token + 7-day expiry) and re-deliver. 30/min throttle.",
    response: '{ "data": { ...SignatureRequest } }',
    errors: [
      'forbidden',
      'not_found',
      'signature_request_not_pending',
      'missing_token',
      'invalid_token',
      'token_expired',
      '429',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/signature-requests/:id/link',
    auth: 'AuthGuard + TenantGuard (signature_requests.send; agent fine gate manage_signatures)',
    summary:
      'P4 — retrieve the signing link for OUT-OF-BAND delivery (phone-less owner). Re-mints a fresh token (prior link dies); signUrl is a BEARER credential so the gate matches SEND, not read. POST (mutates jti); 30/min throttle.',
    response: '{ "data": { "request": { ...SignatureRequest }, "signUrl": "https://…" } }',
    errors: [
      'forbidden',
      'not_found',
      'signature_request_not_pending',
      'missing_token',
      'invalid_token',
      'token_expired',
      '429',
    ],
  },

  // — Roles (P2 Phase 1 — custom permission groups; Owner/Admin governance) —
  {
    method: 'GET',
    path: '/api/v1/roles',
    auth: 'AuthGuard + TenantGuard (roles.read — every org role incl. Viewer)',
    summary: 'List system + org-custom roles.',
    response: '{ "data": [ {Role} ] }',
    errors: ['forbidden', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'GET',
    path: '/api/v1/roles/catalog',
    auth: 'AuthGuard + TenantGuard (roles.read)',
    summary: 'The grantable permission catalog (drives the FE picker; never hardcoded FE-side).',
    response: '{ "data": [ {PermissionCatalogEntry} ] }',
    errors: ['forbidden', 'missing_token', 'invalid_token', 'token_expired'],
  },
  {
    method: 'POST',
    path: '/api/v1/roles',
    auth: 'AuthGuard + TenantGuard (roles.manage — Owner/Admin ONLY; Manager cannot mint roles)',
    summary:
      'Create an org-custom role. Fine anti-escalation in the service: grants must be a subset of the actor effective set; governance roles.*/org.* are Owner-only.',
    request: CreateCustomRoleInput,
    response: '{ "data": { ...Role } }',
    errors: [
      'validation_error',
      'forbidden',
      'role_name_taken',
      'unknown_permission',
      'permission_not_held',
      'governance_owner_only',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/roles/:id',
    auth: 'AuthGuard + TenantGuard (roles.manage — Owner/Admin)',
    summary: 'Update an org-custom role (system roles immutable). Same anti-escalation gates.',
    request: UpdateCustomRoleInput,
    response: '{ "data": { ...Role } }',
    errors: [
      'validation_error',
      'forbidden',
      'role_not_found',
      'system_role_immutable',
      'unknown_permission',
      'permission_not_held',
      'governance_owner_only',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/roles/:id',
    auth: 'AuthGuard + TenantGuard (roles.manage — Owner/Admin)',
    summary: 'Delete an org-custom role (rejected while assigned; system roles immutable). 204.',
    response: '(204 No Content)',
    errors: [
      'forbidden',
      'role_not_found',
      'role_in_use',
      'system_role_immutable',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/roles/assignments',
    auth: 'AuthGuard + TenantGuard (roles.assign — Owner/Admin)',
    summary:
      'Assign a role to a member (tier guard for Owner/Admin grants; cannot self-assign). 204.',
    request: AssignRoleInput,
    response: '(204 No Content)',
    errors: [
      'validation_error',
      'forbidden',
      'member_not_found',
      'role_not_found',
      'owner_required_for_tier',
      'cannot_assign_self',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },
  {
    method: 'DELETE',
    path: '/api/v1/roles/assignments',
    auth: 'AuthGuard + TenantGuard (roles.revoke — Owner/Admin)',
    summary: 'Revoke a role assignment (last-Owner safety guard). 204.',
    request: RevokeRoleInput,
    response: '(204 No Content)',
    errors: [
      'validation_error',
      'forbidden',
      'assignment_not_found',
      'cannot_revoke_last_owner',
      'missing_token',
      'invalid_token',
      'token_expired',
    ],
  },

  // — Provider Admin: identity + self-audit + writes (D.45 / D.49) —
  {
    method: 'GET',
    path: '/api/v1/provider/me',
    auth: 'ProviderAuthGuard',
    summary:
      'Provider Admin self-identity (gates the FE /provider subtree). No audit row — identity probes are not cross-tenant access (D.37 satisfied by login + each cross-tenant call).',
    response: '{ "data": { ...ProviderProfile } }',
    errors: ['missing_token', 'invalid_token', 'token_expired', 'session_revoked'],
  },
  {
    method: 'GET',
    path: '/api/v1/provider/audit/self',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard',
    summary:
      'B-PROVIDER-2 — the PROVIDER\'S OWN action log (provider_audit_log; distinct from the customers\' /provider/audit). Answers "who on our team accessed customer X, when, why?". 30/min.',
    request: ProviderSelfAuditQuerySchema,
    response:
      '{ "data": [ {ProviderSelfAuditItem} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
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
    path: '/api/v1/provider/tenants/:id/users',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard',
    summary:
      "Tier-1 #1 — the target org's MEMBERS, cursor-paginated, READ-ONLY + PII-MASKED. 10/min cap (bounds member-graph enumeration).",
    request: ListTenantUsersQuerySchema,
    response:
      '{ "data": [ {TenantUserItem (masked)} ], "page": { "limit": int, "cursor": "string|null", "has_more": bool } }',
    errors: [
      'validation_error',
      'invalid_cursor',
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
    method: 'POST',
    path: '/api/v1/provider/tenants',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard (PROVIDER_POLICY write)',
    summary:
      'D.45 — onboard a tenant: create the Org + invite its first Manager (atomic). Mandatory access_reason; audit-first interceptor; 10/min write posture.',
    request: OnboardOrgBodySchema,
    response: '{ "data": { ...OnboardOrgResult } }',
    errors: [
      'validation_error',
      'reason_required',
      'missing_token',
      'invalid_token',
      'token_expired',
      'session_revoked',
      'forbidden',
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/provider/tenants/:id/suspend',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard (PROVIDER_POLICY write)',
    summary:
      'D.49 — suspend a tenant org (org-tier auth + data access blocked while suspended). Mandatory access_reason; audited; 10/min.',
    request: SuspendTenantBodySchema,
    response: '{ "data": { ...TenantSuspensionState } }',
    errors: [
      'validation_error',
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
    method: 'POST',
    path: '/api/v1/provider/tenants/:id/reactivate',
    auth: 'ProviderAuthGuard + ProviderAuthorizationGuard (PROVIDER_POLICY write)',
    summary: 'D.49 — reactivate a suspended tenant org. Mandatory access_reason; audited; 10/min.',
    response: '{ "data": { ...TenantSuspensionState } }',
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
