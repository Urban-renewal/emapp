/**
 * Provider Admin API client — wraps the D.37 wire contracts under
 * `/api/v1/provider/*`. Read-only (Gate-6 gates any write). Every
 * call MUST carry the `access_reason` HTTP header; missing → 400
 * `reason_required` per the BE contract.
 *
 * Threat-model linkage (per CLAUDE.md security + perf + error handling):
 *  - **Security:** Provider tier bypasses RLS. Every call is recorded
 *    in `provider_audit_log` with the supplied reason. The FE MUST
 *    refuse to send a request without a reason (defense in depth on
 *    top of the BE 400). Missing reason here would create an audit
 *    row with `reason: '(empty)'` which the BE rejects, but failing
 *    FE-side keeps the operator's intent loud.
 *  - **Performance:** Defensive `.parse()` on every response is O(n)
 *    over the page; for the list endpoints (limit ≤ 100) that's
 *    bounded. No N+1.
 *  - **Error handling:** Every function throws `ApiClientError`
 *    carrying the D.16 `{ code, message?, details? }` envelope so the
 *    caller can `error.code`-switch (e.g. `reason_required` vs
 *    `provider_forbidden` vs `tenant_not_found`).
 */
import {
  ListTenantsQuerySchema,
  ProviderAuditItemSchema,
  OnboardOrgBodySchema,
  OnboardOrgResultSchema,
  ProviderAuditQuerySchema,
  SuspendTenantBodySchema,
  SystemHealthSchema,
  TenantDetailSchema,
  TenantListItemSchema,
  TenantSuspensionStateSchema,
  type OnboardOrgBody,
  type OnboardOrgResult,
  type ProviderAuditItem,
  type ProviderAuditQuery,
  type SystemHealth,
  type TenantDetail,
  type TenantListItem,
  type TenantSuspensionState,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk, type ApiFetchOptions } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema, type Page } from './paging';

/**
 * The mandatory `access_reason` HTTP header. Centralised so a future
 * rename (`access_reason` ↔ `X-Reason` back-compat fallback) is a one-
 * line change. The header value is the operator-supplied free-text
 * reason; the FE wrapper requires non-empty/non-whitespace before any
 * call leaves the browser.
 */
const ACCESS_REASON_HEADER = 'access_reason';

/** Sentinel error a caller can `instanceof` to detect the FE-side
 *  contract block (vs the BE's `reason_required` 400). */
export class ProviderReasonRequiredError extends Error {
  readonly code = 'reason_required_local' as const;
  constructor() {
    super('Provider Admin call refused: access_reason is empty');
    this.name = 'ProviderReasonRequiredError';
  }
}

/**
 * Headers merger that preserves caller-supplied entries while injecting
 * `access_reason`. Returns a plain `Record<string, string>` because the
 * underlying api-client spreads `rest.headers` as a Record (it does NOT
 * iterate a `Headers` instance) — see `apps/web/src/lib/api-client.ts:163`.
 *
 * Non-ASCII handling (operators writing Hebrew / em-dash in reasons):
 *  - `fetch`'s underlying `Headers` ByteString constraint rejects code
 *    points > 0xFF, which would otherwise crash an Israeli operator's
 *    request with a cryptic `TypeError: Cannot convert argument to a
 *    ByteString`.
 *  - We URL-encode the reason if ANY non-ASCII char is present. The
 *    BE decode logic (controller-side) treats the header value as
 *    percent-encoded UTF-8; ASCII-only reasons go through verbatim
 *    so the BE audit row reads identically to today.
 *  - The chosen marker is "%xx"-style %-encoding (RFC 3986). It's
 *    unambiguous, every BE language has a built-in decode, and
 *    pure ASCII reasons are unchanged (`encodeURIComponent('abc')
 *    === 'abc'`).
 */
function withReason(reason: string, init?: ApiFetchOptions): ApiFetchOptions {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new ProviderReasonRequiredError();
  // ASCII-only fast path — most operator reasons are ticket-id refs
  // ("incident #42"), so don't pay the URI-encode cost.
  // eslint-disable-next-line no-control-regex -- intentional: detect non-printable / non-ASCII chars
  const headerValue = /^[\x20-\x7E]+$/.test(trimmed) ? trimmed : encodeURIComponent(trimmed);
  const merged: Record<string, string> = {};
  if (init?.headers) {
    // init.headers may be a Record, a Headers instance, or an array
    // of tuples. Normalise via Headers→entries to one Record.
    const tmp = new Headers(init.headers);
    tmp.forEach((v, k) => {
      merged[k] = v;
    });
  }
  merged[ACCESS_REASON_HEADER] = headerValue;
  return { ...init, headers: merged };
}

// ───────────────────────────────────────────────────────────────────
// Tenants — list + detail.
// ───────────────────────────────────────────────────────────────────

/** Page envelope for the tenant list. Reuses the shared PageSchema
 *  (D.16 cursor pagination) — same shape every list endpoint uses. */
export interface TenantListPage {
  items: TenantListItem[];
  page: Page;
}

export async function listTenants(
  reason: string,
  query: { limit?: number; cursor?: string; q?: string } = {},
): Promise<TenantListPage> {
  // FE-side defensive parse on the query — never send a malformed cursor.
  const parsed = ListTenantsQuerySchema.parse(query);
  const params = new URLSearchParams();
  params.set('limit', String(parsed.limit));
  if (parsed.cursor) params.set('cursor', parsed.cursor);
  if (parsed.q) params.set('q', parsed.q);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/provider/tenants${qs ? `?${qs}` : ''}`,
    withReason(reason),
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(TenantListItemSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

const TenantDetailDataSchema = z.object({ data: TenantDetailSchema });

export async function getTenant(reason: string, id: string): Promise<TenantDetail> {
  const res = await apiClient.get<unknown>(`/provider/tenants/${id}`, withReason(reason));
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TenantDetailDataSchema.parse({ data: res.data }).data;
}

// ───────────────────────────────────────────────────────────────────
// D.49 — Provider WRITE actions: suspend / reactivate a tenant.
// Both POST through the audit-first `withProvider` path; the mandatory
// `access_reason` header (session gate) lands on the forensic audit row.
// `note` (suspend only) is the operator-facing reason persisted on the
// org and shown in the console — distinct from the forensic reason.
// ───────────────────────────────────────────────────────────────────

const TenantSuspensionDataSchema = z.object({ data: TenantSuspensionStateSchema });

export async function suspendTenant(
  reason: string,
  id: string,
  note?: string,
): Promise<TenantSuspensionState> {
  // FE-side defensive parse on the body — never send a malformed note.
  const body = SuspendTenantBodySchema.parse(note && note.trim() ? { note: note.trim() } : {});
  const res = await apiClient.post<unknown>(
    `/provider/tenants/${id}/suspend`,
    body,
    withReason(reason),
  );
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TenantSuspensionDataSchema.parse({ data: res.data }).data;
}

export async function reactivateTenant(reason: string, id: string): Promise<TenantSuspensionState> {
  const res = await apiClient.post<unknown>(
    `/provider/tenants/${id}/reactivate`,
    {},
    withReason(reason),
  );
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TenantSuspensionDataSchema.parse({ data: res.data }).data;
}

// ───────────────────────────────────────────────────────────────────
// D.45 — Provider-initiated onboarding: create an Org + invite the first
// Manager. POST /provider/tenants. Defensive parse on BOTH the body
// (never send a malformed request) and the response (never trust wire).
// ───────────────────────────────────────────────────────────────────

const OnboardOrgDataSchema = z.object({ data: OnboardOrgResultSchema });

export async function onboardOrg(reason: string, body: OnboardOrgBody): Promise<OnboardOrgResult> {
  const parsed = OnboardOrgBodySchema.parse(body);
  const res = await apiClient.post<unknown>('/provider/tenants', parsed, withReason(reason));
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OnboardOrgDataSchema.parse({ data: res.data }).data;
}

// ───────────────────────────────────────────────────────────────────
// Audit search — cross-tenant.
// SA-4 (audit v1.1) enforces "orgId OR (fromDate AND ≤31d span)".
// The FE-side schema parse below catches malformed queries BEFORE
// a single byte leaves the browser — same posture as the BE pipe.
// ───────────────────────────────────────────────────────────────────

export interface ProviderAuditListPage {
  items: ProviderAuditItem[];
  page: Page;
}

export async function searchAudit(
  reason: string,
  query: ProviderAuditQuery,
): Promise<ProviderAuditListPage> {
  // §SA-4 FE mirror — refuse unbounded searches before the network call.
  const parsed = ProviderAuditQuerySchema.parse(query);
  const params = new URLSearchParams();
  params.set('limit', String(parsed.limit));
  if (parsed.cursor) params.set('cursor', parsed.cursor);
  if (parsed.orgId) params.set('orgId', parsed.orgId);
  if (parsed.action) params.set('action', parsed.action);
  if (parsed.fromDate) params.set('fromDate', parsed.fromDate.toISOString());
  if (parsed.toDate) params.set('toDate', parsed.toDate.toISOString());
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/provider/audit${qs ? `?${qs}` : ''}`,
    withReason(reason),
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ProviderAuditItemSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

// ───────────────────────────────────────────────────────────────────
// System health — gauges.
// ───────────────────────────────────────────────────────────────────

const SystemHealthDataSchema = z.object({ data: SystemHealthSchema });

export async function getSystemHealth(reason: string): Promise<SystemHealth> {
  const res = await apiClient.get<unknown>('/provider/system-health', withReason(reason));
  if (!isOk(res)) throw new ApiClientError(res.error);
  return SystemHealthDataSchema.parse({ data: res.data }).data;
}

// Re-export for tests + consumers that need to detect / inject the
// header name (e.g. an integration test confirming the wire shape).
export const PROVIDER_HEADERS = Object.freeze({
  ACCESS_REASON: ACCESS_REASON_HEADER,
} as const);
