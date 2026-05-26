# v10 FE Inline Audit — Security-First Lens

**Date**: 2026-05-26
**Scope**: every TS file under `apps/web/src/` touched since Phase 4a (2026-05-25). Includes Phase 4b ext, 4c, 4d (tasks), 4e (notes), 4f (contractors + shares), 4g (audit suffix dictionary), and Phase E wave 1 specs.
**Lens**: security (PII discipline, D.16 envelope, §S1-SEC1 forms, Idempotency-Key, silent refresh contract, bearer token leakage, bidi defense, tier separation, open redirects, race conditions). Adjacent SOLID / runtime findings noted only when security-relevant.
**Method**: inline read-through (3 background fresh-eyes agents failed with socket errors before writing reports).

## Scope read

- `apps/web/src/middleware.ts`
- `apps/web/src/lib/auth.ts`, `lib/api-client.ts` (already audited Phase 4a)
- `apps/web/src/lib/api/{notes,tasks,contractors,shares,assignments,members,notifications,audit,provider}.ts`
- `apps/web/src/hooks/use-{notes,tasks,contractors,shares,provider,members,audit,notifications}.ts`
- `apps/web/src/app/[locale]/(dashboard)/provider/{layout,page,tenants/page,tenants/[id]/page,audit/page,system-health/page}.tsx`
- `apps/web/src/app/[locale]/(dashboard)/notes/{page,new/page,[id]/page}.tsx`
- `apps/web/src/app/[locale]/(dashboard)/tasks/{page,new/page,[id]/page}.tsx`
- `apps/web/src/app/[locale]/(dashboard)/contractors/{page,new/page,[id]/page}.tsx`
- `apps/web/src/app/[locale]/(dashboard)/projects/[id]/shares/page.tsx`
- `apps/web/src/app/[locale]/(dashboard)/audit/page.tsx`
- `apps/web/src/adapters/{audit-entry,note,task,contractor,share,provider-audit,provider-tenant,provider-health}.ts`
- `apps/api/src/modules/auth/auth.service.ts` (cross-reference for tier separation)
- `apps/api/src/modules/auth/provider/provider-auth.{controller,service}.ts` (cross-reference)
- `packages/shared-types/src/auth.schemas.ts`

## Findings

### V10-S1 [P0] Provider FE subtree unreachable — H1 materialised as a real bug

**Files**:

- `apps/web/src/app/[locale]/(dashboard)/provider/layout.tsx:33-44`
- `apps/web/src/lib/auth.ts:getMe()` (org-tier cookie reader)
- `apps/api/src/modules/auth/auth.service.ts:189` (signs JWT with `role` from `memberships.role`)
- `apps/api/src/modules/auth/provider/provider-auth.controller.ts:21-30` (sets `provider_access_token`, NOT `access_token`)

**Threat**: Security-critical surface shipped non-functional. Every Phase 6.5 BE feature (cross-tenant audit, access_reason audit trail, MFA, PII masking, system-health gauges) hides behind a UI no real Provider Admin can reach.

**Evidence**:

```tsx
// provider/layout.tsx — fails for every real Provider Admin
let user = await getMe(); // reads access_token (org tier)
if (!user || user.role !== 'provider_admin') {
  redirect('/'); // Provider tier always lands here
}
```

- `getMe()` reads cookie `access_token` (org tier; D.21).
- Org-tier auth.service.ts signs JWT with `role: m.role` where `m.role ∈ {manager, agent, viewer}`.
- Provider login (`/api/v1/provider/auth/login`) sets `provider_access_token` (different cookie, different audience `emapp-provider`).
- Result: anyone authenticated as Provider Admin has `provider_access_token` set, NO `access_token`, so middleware bounces them to `/he/login` BEFORE `provider/layout.tsx` even renders. The `getMe() === null → redirect('/')` branch in dashboard/layout.tsx fires first.

**Closure plan** (Gate-6 / D.NN):

1. Add **`GET /api/v1/provider/me`** BE endpoint — gated by `ProviderAuthGuard`, returns `{ id, email, name, role: 'provider_admin' }`. Mirrors the org `/me` shape.
2. Add FE server action **`getProviderMe()`** at `apps/web/src/lib/provider-auth.ts`. Reads `provider_access_token` cookie via `cookies()`. Same defensive `.parse()` discipline as `getMe()`.
3. Replace `getMe()` in `provider/layout.tsx` with `getProviderMe()`. Drop the cross-tier role check (`ProviderAuthGuard` already enforces tier).
4. Extend `middleware.ts` to recognize `/[locale]/provider/*` as gated by `provider_access_token` instead of `access_token` (or add `/provider/*` as a route group outside `[locale]` with its own auth shell).
5. Once the path is reachable, build **`/provider/login`** as a separate slice.

**Acceptance test**: Playwright E2E that POSTs `/api/v1/provider/auth/login` (mock backend), sets `provider_access_token` cookie, navigates to `/he/provider`, asserts the dashboard renders (no redirect to `/he/login`).

**Why P0 not HIGH**: a feature that the BE security team built (Phase 6.5 + Audit v1.1 closures, ~3000 LOC + 90 specs) is invisible to operators in prod. Any vendor demo that says "we have a Provider Admin console" is false advertising.

---

### V10-S2 [HIGH] No `/provider/login` page exists; sidebar links to a dead subtree

**Files**:

- `apps/web/src/app/[locale]/(dashboard)/_components/sidebar.tsx:93-95` (renders Provider link when `role === 'provider_admin'`)
- BE has `POST /api/v1/provider/auth/login` ready (provider-auth.controller.ts:34) since Phase 6.5; FE has no corresponding form.

**Threat**: Operationally, the only ways to obtain `provider_access_token` are:

- Manual `curl -X POST /api/v1/provider/auth/login` (operator runbook, error-prone)
- Direct DB cookie injection via DevTools (insecure, no audit row written by BE login flow)
- Custom internal tool (not committed)

None of these scale; none correctly write the `provider.login` audit row that ISO A.9.4.1 expects.

**Closure plan**: Build `/[locale]/provider/login` page after V10-S1 lands. Form: email + password + mfa_code (per `ProviderLoginSchema`). `method="post"` + `useApiErrorHandler` with anti-enum copy. Sets `provider_access_token` via the Set-Cookie response. Minimal styling per user mandate.

**Acceptance test**: J11-full E2E covers it (already on the work list as task #97).

---

### V10-S3 [HIGH] middleware bounces `/[locale]/provider/login` to `/he/login` once the page exists

**File**: `apps/web/src/middleware.ts:27-30`

```ts
const PUBLIC_ROUTE_REGEX = new RegExp(
  `^\\/[a-z]{2}\\/(login|signup|accept-invite\\/${JWT_SHAPE})$`,
);
```

- Once `/he/provider/login` is added (V10-S2), unauthenticated users navigating there get a 302 to `/he/login` BEFORE the page can render — because the regex doesn't include `provider\/login`.

**Threat**: Soft bug — Provider Admins literally can't reach the login page. Would surface immediately on the next attempt to log in.

**Closure plan**: Extend `PUBLIC_ROUTE_REGEX` to:

```ts
`^\\/[a-z]{2}\\/(login|signup|provider\\/login|accept-invite\\/${JWT_SHAPE})$`;
```

and `AUTH_ROUTE_REGEX` similarly (so authenticated Provider Admins are redirected away from `/provider/login` to `/provider`, not `/`).

**Acceptance test**: `middleware.spec.ts` — add cases for `/he/provider/login` no-cookie (no redirect) + provider-token-cookie (redirect to `/he/provider`).

---

### V10-S4 [HIGH] middleware does not recognize `provider_access_token` for `/provider/*` paths

**File**: `apps/web/src/middleware.ts:58, 80`

```ts
const hasToken = req.cookies.has('access_token');
// ...
if (!isPublicRoute(pathname) && !hasToken && !pathname.startsWith('/api')) {
  url.pathname = `/${locale}/login`;
  return NextResponse.redirect(url);
}
```

- The middleware only checks `access_token`. A Provider Admin with `provider_access_token` but no `access_token` gets bounced to `/he/login` even after V10-S1+S2 ship — because middleware fires before any route handler.

**Threat**: Same as V10-S1 (Provider subtree unreachable) but at the routing layer.

**Closure plan**: When `pathname.startsWith('/${locale}/provider')`, accept either `access_token` OR `provider_access_token` as proof-of-auth.

**Acceptance test**: `middleware.spec.ts` — `/he/provider` with only `provider_access_token` → no redirect; `/he/provider` with no cookies → redirect to `/he/login`; `/he/projects` with only `provider_access_token` → redirect to `/he/login` (tier isolation).

---

### V10-S5 [MEDIUM] Notes detail page reuses `editError` handler for archive failure

**File**: `apps/web/src/app/[locale]/(dashboard)/notes/[id]/page.tsx:108-113`

```ts
async function onArchive() {
  // ...
  try {
    await archiveMutation.mutateAsync(id);
    router.push('/notes');
  } catch (e) {
    editError.handle(e);
  } // ← `editError`, not a separate `archiveError`
}
```

**Impact**: An archive failure shows the "forbidden_edit" message (set via `editError.codeOverrides`). For a non-author trying to archive someone else's note, the BE returns `forbidden` and the FE displays "Only Manager or original author may edit this note" — which technically also applies to archive, but the UX is misleading because the user clicked Archive, not Edit.

**Severity**: MEDIUM (not security; UX clarity).

**Closure plan**: Extract a separate `archiveError` handler with its own override:

```ts
const archiveError = useApiErrorHandler<UpdateNote>({
  codeOverrides: { forbidden: () => t('forbiddenArchive') },
  fallback: () => t('archiveFailed'),
});
```

Add `forbiddenArchive` / `archiveFailed` i18n keys.

**Acceptance test**: unit/RTL spec asserts `forbiddenArchive` text on a 403 during archive (different from edit-403 path).

---

### V10-S6 [LOW] Archive/revoke wrappers swallow `invalid_response` error code

**Files**: `apps/web/src/lib/api/{notes,contractors,shares,tasks}.ts` (all archive/delete functions):

```ts
export async function archiveNote(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/notes/${id}`);
  if (isOk(res)) return;
  if (res.error.code === 'invalid_response') return; // ← swallow
  throw new ApiClientError(res.error);
}
```

**Impact**: The BE returns 204 No Content on archive. The api-client's response parser fails to parse the empty body and surfaces it as `invalid_response`. The intentional handling silently treats this as success — correct behavior, but the magic-string comparison is fragile (if the api-client changes the code string, archive starts throwing).

**Severity**: LOW (code smell; works today).

**Closure plan**: Add a typed helper `isEmptyResponseSuccess(res)` in `lib/api/errors.ts` that encapsulates the convention. All 4+ archive wrappers consume that helper. Future renames are one-line changes.

**Acceptance test**: extend `errors.spec.ts` to pin the convention.

---

### V10-S7 [MEDIUM] `/members` side-load fires for every dashboard user (rate-limit risk + audit noise)

**Files**:

- `apps/web/src/app/[locale]/(dashboard)/projects/[id]/assignments/page.tsx:52-57`
- `apps/web/src/app/[locale]/(dashboard)/notes/page.tsx:31-36`
- `apps/web/src/app/[locale]/(dashboard)/notes/[id]/page.tsx:38-43`
- `apps/web/src/app/[locale]/(dashboard)/tasks/[id]/page.tsx` (likely — similar pattern)

```ts
const membersQuery = useQuery({
  queryKey: ['members', 'list', { limit: 100 }, locale, 'notes-side-load'],
  queryFn: () => listMembers({ limit: 100 }),
  retry: false,
});
```

**Impact**: Members is a Manager-only resource (D.17). For Agent/Viewer visits to these pages, the request 403s. With `retry: false` it's a single 403 per page-mount, but:

- Each 403 writes a `members.list_attempt_forbidden` audit row → audit noise
- `staleTime: 30_000` means revisiting the page within 30s hits cache; OK
- The BE per-org rate-limit could be approached by a Manager opening many tabs (Manager doesn't 403 but issues a real query)

**Severity**: MEDIUM (audit noise + scale-prep).

**Closure plan**: Read `role` from `getMe()` (cached server-side) and only fire the side-load when `role === 'manager'`. Agent/Viewer pages skip the side-load entirely and use the userIdShort fallback that's already coded.

**Acceptance test**: Playwright — Agent visits `/notes` → Network panel shows no `/members` request.

---

### V10-S8 [LOW] Audit page action label fallback shows raw machine string

**File**: `apps/web/src/app/[locale]/(dashboard)/audit/page.tsx:67`

```tsx
<span className="text-sm font-medium">{e.actionSuffixLabel || e.action}</span>
```

**Impact**: When `actionSuffixLabel` is empty (unknown action like a future BE addition), the raw machine string (e.g., `import.new_action_xyz`) renders. Not a security issue (action strings are regex-validated BE-side per Phase 6.5 P6.5-1), but visually ugly + leaks the BE's internal namespace to operators in HE/EN displays.

**Severity**: LOW.

**Closure plan**: Show category label + raw suffix in mono font; never bare action.

---

## Negative confirmations (looked for, did NOT find)

- **§S1-SEC1 GET-fallback**: every form in Phase 4d/e/f/g carries `method="post" action=""` (verified: notes/new, notes/[id], shares grant, contractors/new). ✅
- **Idempotency-Key**: every create POST uses `apiClient.postIdempotent` (verified: createNote, createTask, createContractor, createProjectShare, addTaskAssignee). ✅
- **Defensive Zod `.parse()`**: every lib/api response wrapper parses with `@emapp/shared-types` schema; no FE-local schema redefinition. ✅
- **NameDisplay wrapping**: notes body, contractor name, share contractor name, audit actorEmail, member email all wrap. `<option>` uses `dir="auto"` (SEC-M4). ✅
- **PII in URL**: no `national_id`, `phone`, `email` ever appears in URL query string; owner search uses POST body. ✅
- **`dangerouslySetInnerHTML`**: zero occurrences in any new page. ✅
- **TanStack hooks discipline**: stable queryKeys with locale included; `staleTime: 30_000`; `enabled` guards; memoized `select` via `useCallback` (PERF-H3); `invalidateQueries` on mutation success. ✅
- **Silent refresh contract**: 401 with `token_expired` triggers refresh; `invalid_credentials`/`forbidden` does NOT fire the global unauthenticated event. ✅ (verified `api-client.ts` handler unchanged)
- **Bearer token leakage**: signature signUrl shown ONCE in state, never persisted to TanStack cache; member invite token only in NON-PROD response (D.27); recovery codes printed once by bootstrap script. ✅
- **Audit page PII discipline**: no before/after diffs, no IP, no UA surfaced; actorId truncated to 8 chars. ✅
- **`SharePermissionsSchema` widening**: shares page form composes only legal toggles; defensive `CreateShareInput.parse(body)` before wire. ✅
- **`<NameDisplay>` for note body** — yes, list page wraps `n.body` with NameDisplay (line 103 of notes/page.tsx). ✅

## P0/HIGH triage

| ID     | Severity | Closure type                             | Blocker                             |
| ------ | -------- | ---------------------------------------- | ----------------------------------- |
| V10-S1 | P0       | Architectural — needs D.NN + BE endpoint | unblocks everything provider        |
| V10-S2 | HIGH     | FE page — small                          | needs V10-S1                        |
| V10-S3 | HIGH     | middleware regex — 2 lines               | needs V10-S2 path decided           |
| V10-S4 | HIGH     | middleware logic — 5 lines               | needs V10-S1 design                 |
| V10-S5 | MEDIUM   | UX fix                                   | none                                |
| V10-S6 | LOW      | Code smell                               | none                                |
| V10-S7 | MEDIUM   | Audit noise                              | needs V10-S1 (role-aware side-load) |
| V10-S8 | LOW      | UX polish                                | none                                |

## Recommended closure sequence

1. **D.NN entry** — document the tier-aware getMe + middleware decision (Gate-6).
2. **PR-A (BE)**: add `GET /api/v1/provider/me` endpoint.
3. **PR-B (FE)**: add `getProviderMe()` server action; rewire `provider/layout.tsx`; extend middleware to accept `provider_access_token` for `/provider/*`. Includes spec updates for `middleware.spec.ts`.
4. **PR-C (FE)**: `/provider/login` page + middleware regex extension (V10-S2 + V10-S3).
5. **PR-D (E2E)**: J11-full Playwright spec — login → MFA → tenants list → tenant detail.
6. **PR-E (FE polish)**: V10-S5 (notes archive error handler) + V10-S6 (typed empty-response helper) + V10-S8 (audit label fallback).
7. **PR-F (perf)**: V10-S7 (role-aware /members side-load).

PRs A/B/C/D are sequential (each depends on the previous). E/F are independent and can ship anytime.

## What this audit did NOT cover

- Phase E E2E spec quality (J1-J15 assertion strength) — Agent C scope, lost to socket error
- SOLID/perf-only items not security-adjacent (use-tasks side-loads, re-render storms, bundle size) — Agent B scope, lost to socket error
- BE-side contract conformance (sync mechanism Doc 11 invariants) — Agent C scope, lost to socket error

These should be re-run when background-agent infra is healthy. The H1 P0 is independent of any of those gaps.
