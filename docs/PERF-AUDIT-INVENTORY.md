# EMAPP Performance-Audit Action Inventory

> The exhaustive checklist for the perf audit. **The harness walks this list to
> exhaustion** — coverage is "list empty", never "3 pages then stop".
> Generated 2026-06-15 from the App Router routes + the 6-role matrix.
> 65 page.tsx routes → 105 distinct measurable actions.

## How the audit runs

- **Environment:** Chrome (Chromium via Playwright) → web `:3001` → API `:3000`
  on `DB_TARGET=local` (the client-faithful path; NOT curl-in-isolation, NOT
  remote Neon).
- **Per action:** COLD first-hit (dev-compile, recorded + labeled artifact) +
  WARM median of ≥3 (the real steady-state number) + the `/api/v1` waterfall
  (each call, its ms, sequential-vs-parallel) + console-clean.
- **Verdict:** WARM ≤ 1000 ms = pass; > 1000 ms = Phase-2 optimization target.

Harness: `apps/web/perf-audit/run.mjs` → writes `docs/PERF-AUDIT-RESULTS.json`
+ `docs/PERF-AUDIT-REPORT.md`.

## Master checklist — 105 distinct measurable actions

### Auth (9)
1. org login `POST /auth/login` · 2. signup `POST /auth/signup` · 3. forgot-password ·
4. reset-password · 5. accept-invite · 6. tenant OTP request `POST /auth/otp/request` ·
7. tenant OTP verify · 8. provider login `POST /provider/auth/login` · 9. silent refresh.

### Session/home (2)
10. load session `GET /me` (every authed page) · 11. logout.

### Projects (6)
12. list `GET /projects` · 13. create · 14. get `GET /projects/:id` · 15. archive ·
16. signature-progress board · 17. drill apartments-by-signature.

### Buildings/apartments (8)
18. list buildings · 19. get building · 20. create building · 21. list apts by building ·
22. create apartment · 23. list apts cross-building · 24. get apartment ·
25. inspect tabu extraction (PDF + confirm).

### Ownership (4)
26. list ownerships · 27. create owner · 28. reveal owner PII `POST /owners/:id/reveal-pii` ·
29. archive owner.

### Owners (4)
30. list owners · 31. get owner (+ `/owners/:id/projects`) · 32. list owner projects · 33. revoke ownership.

### Documents (8)
34. list · 35. create · 36. upload (R2/content) · 37. finalize · 38. get · 39. view ·
40. download · 41. archive.

### Signature requests (8)
42. list · 43. create · 44. get · 45. resend · 46. cancel · 47. public sign preview `GET /sign/:token` ·
48. public sign submit · 49. signed confirmation.

### Imports (8)
50. list · 51. create-metadata · 52. upload to R2 · 53. start · 54. status · 55. SSE stream ·
56. submit mapping · 57. list errors.

### Messaging (5)
58. list conversations (`?limit=50`, 15s poll) · 59. create conversation ·
60. list messages (8s poll) · 61. send message · 62. mark read.

### Members/IAM (10)
63. list · 64. invite · 65. get · 66. update role · 67. apply preset · 68. set override ·
69. clear override · 70. resend invite · 71. remove · 72. role matrix `GET /permissions`.

### Tasks/notes (9)
73. list tasks · 74. create task · 75. get task · 76. update task · 77. list notes ·
78. create note · 79. get note · 80. update note · 81. delete note.

### Notifications/audit (4)
82. list notifications (`?limit=50`) · 83. mark read · 84. org audit · 85. notification deep-link.

### Contractors (4)
86. list · 87. create · 88. get · 89. regenerate token.

### Contractor portal (3)
90. token exchange `/share/:token` · 91. view project · 92. download doc.

### Settings/org (3)
93. get settings · 94. update settings · 95. project assignments.

### Provider (10)
96. provider login · 97. dashboard `GET /provider/system-health` · 98. list tenants ·
99. get tenant · 100. tenant users · 101. disable/enable user · 102. provider audit ·
103. provider self-audit · 104. system-health detailed · 105. force recheck.

## Notes that shape measurement
- **Keyset pagination** everywhere (`?limit&cursor`) — list cost is ~constant in page size.
- **Dashboard home** pays `/me` (server) + `/org/stats` + `/notifications` + `/conversations` + `/members` — the heaviest stack; login redirects into it.
- **`/me`** = `loadProfile` (1 query) + `resolveEffectivePermissions` (own withTenant) — the per-session tax.
- Mutations auto-mint Idempotency-Key; PII reveal is ephemeral (uncached).
