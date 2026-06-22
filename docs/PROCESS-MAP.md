# EMAPP — Complete Process Map

> Generated 2026-06-22 by enumeration from source (NOT memory): 190 HTTP routes across 45
> controllers + the `@emapp/jobs` package + `apps/worker` handlers + the provider seams/services.
> Verification basis at the bottom. An independent completeness audit was run to catch omissions.

## Tier 1 — Org users (Manager / Agent / Viewer)

### A. Identity & access
1. Org signup → atomic bootstrap (org + first manager) — `auth POST /signup`
2. Login (access+refresh cookies, rotation, reuse-detection) — `auth POST /login`
3. Token refresh — `auth POST /refresh`
4. Logout — `auth POST /logout`
5. Switch org — `auth POST /switch-org`
6. Forgot password → reset password — `auth POST /forgot-password`, `/reset-password`
7. Accept team invite — `auth POST /accept-invite`
8. Step-up re-auth (for PII reveal) — `auth/step-up POST /request`, `/verify`
9. OTP request/verify (shared primitive) — `auth/otp POST /request`, `/verify`
10. Current user profile — `me GET /`

### B. Org, team & permissions
11. Org settings (view/update) — `org/settings GET|PATCH /`
12. Team members CRUD + invite + resend — `members` (8 routes)
13. Per-member capabilities + presets — `members PATCH /:userId/capabilities`, `/apply-capability-preset`, `GET /capability-presets`
14. Per-member permission overrides (grant/deny, anti-escalation) — `members/:userId/overrides GET|PUT|DELETE`
15. Roles management + assignment — `roles` (7 routes: list/catalog/create/patch/delete/assign/unassign)

### C. Projects & structure
16. Projects CRUD + status state-machine (planning→gathering_signatures→approved→in_construction→completed/cancelled) — `projects` (create/patch/archive)
17. Project agent-assignments — `project-assignments` (list/add/remove)
18. Buildings CRUD — `buildings` (5 routes)
19. Apartments CRUD — `apartments` (5 routes)
20. Ownerships set-replace (sum CHECK) — `ownerships GET|PUT`

### D. Owners & PII
21. Owners CRUD — `owners` (create/patch/delete/get)
22. CSV import: upload → mapping → errors → start → confirm → stream — `imports` (9 routes)
23. Owner search (local + cross-project national_id lookup, view_owner_pii-gated) — `owners POST|GET /search`
24. PII reveal (step-up + permission gated, audited) — `owners POST /:id/reveal-pii`
25. Owner ↔ projects — `owners GET /:id/projects`
26. RTBF: data-export + erase — `owners GET /:id/data-export`, `POST /:id/erase`

### E. Documents
27. Upload: create → content → finalize (envelope encryption at-rest for sensitive) — `documents POST /`, `/:id/content`, `/:id/finalize`
28. doc_type taxonomy + scope classification
29. Per-project required-docs checklist + completeness % — `projects GET /:id/document-checklist`
30. Heuristic classify (suggest-only) — `documents POST /classify`
31. Dedup probe (contentHash) — `documents POST /dedup-check`
32. Download (decrypt-stream for sensitive) — `documents GET /:id/download`
33. Search / edit / archive — `documents GET /search`, `PATCH|DELETE /:id`
34. Remediation sweep (re-classify pre-existing tabu docs) — `documents POST /remediation-sweep`

### F. Signatures (core)
35. Create signature request: single / bulk / per-apartment signable doc — `signature-requests POST /`, `/bulk`
36. Signature campaign (mass send) + reminder + kill-switch — `projects POST /:id/signature-campaign`, `/:id/signature-requests/remind`
37. Public signing flow (token → view doc → draw signature → submit; single-use, SVG-sanitized) — `sign GET|POST /:token`
38. Progress / consent (share-weighted consentedPct, per-apartment) — `projects GET /:id/signature-progress[/apartments]`
39. Holdout detection (PII-gated names) — `projects GET /:id/signature-progress/apartments/:apartmentId/holdouts`
40. Cancel / resend / link signature request — `signature-requests POST /:id/cancel|/resend|/link`
41. Signed-document retrieval (certificate PDF) — `signature-requests GET /:id/signed-document`

### G. Tabu / land-registry
42. Tabu extraction create + async extract — `tabu-extractions POST /apartments/:id/tabu-extractions`, `/:id/extract`
43. Review rows + mandatory human confirm (provenance) — `tabu-extractions GET /:id/rows`, `PATCH /:id/rows/:rowId`, `POST /:id/confirm`
44. Parcel auto-setup (gush/helka; GovMap owner-gated) — `parcel-setups` (create/list/get/patch/confirm)
45. Discovery/renter records on apartment — `discovery` (list/create/patch)

### H. External collaboration
46. Contractors CRUD — `contractors` (5 routes)
47. Project shares (share-based JSONB perms) — `shares GET|POST /projects/:projectId/shares`
48. External shares (presets, OTP gate, watermark): create/edit/extend/resend/revoke — `external-shares` (6 routes)

### I. Productivity & comms
49. Notes CRUD — `notes` (5 routes)
50. Tasks CRUD + assignees + overdue — `tasks` (8 routes incl. assignees add/remove)
51. Team messaging/chat — `conversations` (6 routes)
52. Notifications: list / unread-count / read-all / read (deep-links) — `notifications` (4 routes)

### J. Situation-picture & analytics
53. Mission-control home board (fleet of all projects)
54. Org signature-pulse + stats — `org GET /signature-pulse`, `/stats`
55. Leverage scorer (marginal delta to threshold) — `projects GET /:id/leverage`
56. Project export → xlsx — `projects/:id/export GET /`

## Tier 2 — External users

### K. Contractor portal (share-token)
57. Contractor read: project / progress / documents / download (sensitive excluded) — `contractor` (4 routes)

### L. Tenant portal (SMS OTP)
58. Tenant login (SMS OTP) + own record only: me / apartment / documents / signatures / progress / resend / logout — `portal` (8 routes)

## Tier 3 — Provider Admin (cross-tenant, MFA)
59. Provider auth (MFA) + profile — `provider/auth` (3), `provider/me` (1)
60. Tenant onboarding — `provider/tenants POST /`
61. Tenant list / detail / users — `provider/tenants GET /`, `/:id`, `/:id/users`
62. Tenant suspend / reactivate — `provider/tenants POST /:id/suspend`, `/reactivate`
63. Provider audit (all + self) — `provider/audit GET /`, `/self`
64. System health — `provider/system-health GET /`

## ★ Background / scheduled / async processes (the "system manages itself" layer) ★
> These have NO (or few) HTTP routes — they run in `apps/worker` / `@emapp/jobs` / provider seams.
> THIS is the category the first pass missed entirely.

65. **Reminder scheduling engine** — `calendar.service` (schedules reminders by rule; 0 routes, internal)
66. **Reminder delivery** — `calendar-email.service` (sends the scheduled reminders)
67. **Signature-request expiry** — `signature-expiry-job` (auto-expires stale requests)
68. **Session/token reaper** — `reaper-job` (purges expired auth_sessions / refresh tokens)
69. **Audit-log retention** — `audit-retention-job` (purges old audit rows)
70. **Async CSV import processing** — `import-job` (+ worker mapping/parser)
71. **Async tabu PDF parsing** — `apps/worker/parser`
72. **R2 storage purge / bytes lifecycle** — `purgeImportBytes`, document bytes cleanup
73. **File scan on upload** — scan-provider (magic-byte / AV gate)
74. **Email sending** — IEmailProvider (member invites, task invites, notifications) via Resend
75. **SMS sending** — ISMSProvider (tenant OTP) via Israeli provider
76. **Breach/bruteforce detection + alerting** — `BreachDetection` + `WebhookAlertSink`
77. **Parcel/GovMap lookup** — IParcelDataProvider (owner-gated)
78. **Prometheus metrics scrape** — `metrics GET /api/v1/metrics` (aggregate only, no PII) + Sentry error tracking
79. **Real-time / SSE** — IRealtimeProvider (import progress `imports GET /:id/stream`; live-update seam)
80. **Cache** — ICacheProvider (PostgresCacheProvider over `cache_kv`; read-through for signature-progress etc.)

## ★ Ops / infra / entry-point flows (added after independent audit — first pass missed these) ★
81. **Liveness probe** — `GET /api/v1/health` (uptime, no DB)
82. **Readiness probe** — `GET /api/v1/ready` (DB connection + process health)
83. **BFF reverse proxy** — web `/api/[...path]` → Railway (header strip, CF-IP rewrite, Set-Cookie passthrough)
84. **Contractor share-token → cookie exchange** — web `/contractor/share/[token]/route.ts` (URL JWT → httpOnly cookie; the contractor-portal entry flow)
85. **Dev-only nav login** — web `/dev-login?role=` (double-gated NODE_ENV+DEV_AUTH_BYPASS; QA tooling only)

> NOTE: `provider/backups` exists ONLY as a FE route with NO backend implementation — deferred/dead, NOT a live process.

## Cross-cutting (not "processes" but govern all of the above)
- RLS FORCE per-org (`withTenant`) / provider (`withProvider`); permission matrix per role
- PII encryption (pgcrypto + envelope at-rest), never logged
- Audit logging (append-only) on sensitive operations

---

### Verification basis
- 190 HTTP routes counted via `grep @(Get|Post|Patch|Put|Delete)` across 45 `*.controller.ts`.
- Background processes from `packages/jobs/src`, `apps/worker/src/handlers`, `calendar*/`, provider seams.
- ⚠️ Known not-yet-verified edges: provider/backups (FE route exists; BE location unconfirmed),
  any FE-only flows, and whether every job is currently scheduled vs. dormant. An independent
  completeness audit was dispatched to close these.
