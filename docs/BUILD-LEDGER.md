# EMAPP BUILD LEDGER — the single source of truth

> Merge of the council catalog (`docs/SYSTEM-CATALOG.html` — every screen×role, ✓/➕, 7-layer
> verification, state-model, build-order 0–3) + the autonomous-managing blueprint
> (`docs/BLUEPRINT-AUTONOMOUS-MANAGING-SYSTEM.md`) + this session's red-team backlog
> (`docs/RED-TEAM-EMAIL-XENTITY-LEDGER-2026-06-25.md`). **On conflict: the catalog + the real code win
> (truth vs code, never a guess).** This is the ONLY plan — do not fork a second one.
>
> **RUN LOOP (CLAUDE.md §RUN-TO-COMPLETION, hard-anchored):** drain PRs → merge green → advance the next
> slice in dependency order → green → merge → dispatch next. Never stop, never wait on the owner. Each
> slice ships through: reuse-seam → technophobe Chrome walk → independent red-team loop → C1–C12 vs the
> catalog → CI green + drift-guard. Status: ✅ done · 🟡 in-progress · ⬜ todo.

## DONE baseline (catalog ✓ + this session)

- **The entire ✓ surface is built:** 16 screens, ~200 routes / 49 controllers, the 7 verification layers,
  4 recommenders (signature-reissue · reminder-cadence · task-watcher · document-chase), 4 scheduled jobs,
  the 6 canonical seams (withTenant/withProvider · governOutboundSend+governor+ledger · providerPartyForDocType
  · detectMissingRequiredDocs · decideExternalPartyAccess · signaturePulse/boardCompleteness/rankAttention).
- **This session merged:** #535 board-completeness single-source · #545 inbox kind-aware count · #547 nav
  badges · #548/#561 docs · #549 external-share honest copy · #550 messages window-shift · #552 dead-array
  cleanup · #556 dev outbox + fail-closed dev-bypass (ONE env-fail-open instance) · #558 campaign DELIVERED-not-
  CREATED · ✅ #560 signing-JWT-in-req.url redaction (red-team HIGH #1).

---

## WAVE 0 — Truth + Speed + Security (fix the foundation before building on it)

_Everything downstream reads these; the security cluster is HIGH and largely independent → runs first/parallel._

| id   | slice · goal                                                                                                                                                                                                                          | seam                                                | now/gated                   | status            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------- | ----------------- |
| 0.1  | **Home stat single-source** — `projects.service.ts:1404-1410` bare COUNT→ agent-branch shape via new `orgStatsSignatureCountsSql`; provider KPI `status IN ('signed','pending')`; + static ratchet `no-adhoc-signature-count.spec.ts` | `projectSetSignatureDocIdsSql`                      | NOW                         | ⬜                |
| 0.2  | **Kill getMe SSR double-hop** — `getMe()` reads `API_BACKEND_URL` server-side; drop proxy self-hop (~0.39s/render)                                                                                                                    | `auth.ts:getMe`                                     | NOW                         | ⬜                |
| 0.3  | **Dev DNS** — `--dns-result-order=ipv4first` on web                                                                                                                                                                                   | `start-dev-local.ps1`                               | flag NOW · hosts-file GATED | ⬜                |
| 0.S1 | **env fail-open → fail-closed (root class)** — API Dockerfile `ENV NODE_ENV=production` (#23) + fail-closed env resolver kills #7/#14(SMS→Noop)/#17(OTP 000000)/#20(invite no-op)/#13/#29(base-url→localhost)                         | the #556 fail-closed pattern                        | NOW                         | ⬜ HIGH           |
| 0.S2 | **token-in-sinks** — Sentry beforeSend URL scrub (#9) · CF Pages Function logs (#15) · `mailErr.message` token (#39) [#560 closed req.url]                                                                                            | the #560 scrub seam                                 | NOW                         | ⬜ HIGH           |
| 0.S3 | **delivery-outcome honesty** — #2 chase toast · #10/#12 external-share "re-issued" · #16 reissue false-WhatsApp · #18 invite "נשלחה" · #22/#27                                                                                        | `didAnyChannelDeliver`/no_channel (#558)            | NOW                         | ⬜ HIGH           |
| 0.S4 | **cross-entity authz** — archive contractor/project revokes shares (#4/#5) · project-scope resolver leaks apartment docs (#11/#30/#31)                                                                                                | `decideExternalPartyAccess`/`resolveDocumentAccess` | NOW                         | ⬜ HIGH           |
| 0.S5 | **OTP/calendar** — enumeration oracle (#8) · non-atomic brute-force lockout (#19/#41) · calendar attendee lifecycle (#21/#34)                                                                                                         | OTP service tx/row-lock                             | NOW                         | ⬜ HIGH           |
| 0.S6 | **error legibility** — sign-page 5xx-as-"link-invalid" (#6) · contractor false-empty (#32/#33) · portal 5xx→login (#36) · docs `error={undefined}` (#38)                                                                              | `DataState`; transient-vs-terminal split            | NOW                         | ⬜ (overlaps 2.3) |

## WAVE 1 — Perception + Recommender spine (the heart of MANAGING)

| id  | slice · goal                                                                                                                                                                                                                                                                                                                      | seam                                                                                                 | now/gated                | status                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------- |
| 1.0 | **Lock catalog + drift-guard** — CI fails a PR adding an enum/route/recommender not in the catalog                                                                                                                                                                                                                                | catalog = source-of-truth                                                                            | NOW                      | 🟡 (catalog locked; guard ⬜) |
| 1.1 | **`ProjectPerception` assembler** — one PII-free per-project set-based reader composing existing seams; home KPI = Σ perception.signatures (drift impossible)                                                                                                                                                                     | signatureProgress + computeConsentAggregates + detectMissingRequiredDocs + PROJECT_TERMINAL_STATUSES | NOW                      | ⬜                            |
| 1.2 | **Executor extraction + auto-execute graduation** — **FIRST** extract `executors` → DI-free `packages/db` `applyProposalEffect(tx,kind,proposal)` (P0-1: approve-path is in API, producer in worker); then producer auto-applies `classify()==='autoExecute'` ∧ org-opt-in (default OFF)                                          | `IRecommender`/`emitProposal`/`classify`/`executors`                                                 | NOW                      | ⬜                            |
| 1.3 | **10 missing recommenders** (catalog): party-contact-resolver · stalled-project-escalation · ready-to-approve · doc/permit-expiry-warn · party-deadline-reminders · ownership-mismatch-flag · action-grouping · link-health-check · smart-task-assignment · sensitive-share-guard — each a new `IRecommender`, no new engine part | the recommender engine                                                                               | NOW (sends propose-only) | ⬜                            |

## WAVE 2 — Auto-data-in + the ➕ future-states

| id  | slice · goal                                                                                                                                                                                                   | seam                                                                   | now/gated | status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------- | ------ |
| 2.1 | **Generate-building-apartments** — "כמה קומות × דירות?" → one confirm generates rows (manager-confirmed, NOT classify)                                                                                         | existing apartments write path                                         | NOW       | ⬜     |
| 2.2 | **נסח→owners, de-jargoned** — collapse 5-button tabu to one "העלה נסח ומלא בעלים"; confidence→badge; + `tabu-autofill-suggest` recommender                                                                     | `tabu.parse.toDraft`→`tabu.confirm.ownerships` (humanOnly floor stays) | NOW       | ⬜     |
| 2.3 | **Schema-vocab de-leak + sign 5xx** — i18n sweep D.25/אטומית/doc_scope/מסמכי-ליבה/unit_type/מונה/מכנה → plain Hebrew; sign-page 5xx→retry stage; + i18n lint banning code/snake_case/math-words in user values | i18n only                                                              | NOW       | ⬜     |
| 2.4 | **Project ➕ states** — objections · permit · financing · hold · final-review (+ recommenders: permit-expiry, objection-flag)                                                                                  | project state-model                                                    | NOW       | ⬜     |
| 2.5 | **Owner ➕ states** — competency (deceased/minor/incapacitated)+guardian · dispute · transfer · lien · verify · consent-withdrawal                                                                             | owners/ownerships model                                                | NOW       | ⬜     |
| 2.6 | **Document ➕ states** — legal-status (draft/reviewed/approved/rejected) · versions (current/superseded) · validity · notary · relevant-phase                                                                  | documents model                                                        | NOW       | ⬜     |
| 2.7 | **Apartment ➕ states** — deceased · dispute/POA · eviction · repairs · rights-transfer                                                                                                                        | apartment model                                                        | NOW       | ⬜     |

## WAVE 3 — Flat-wall closure + P1 convergence + per-screen rollout

| id  | slice · goal                                                                                                                             | seam                                              | now/gated | status |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------- | ------ |
| 3.1 | **Tasks situation-picture** — grouped/attention-first; render task.create proposals + at-risk badge                                      | `groupByKind`→`groupByDueDate` + board-primitives | NOW       | ⬜     |
| 3.2 | **Documents → reuse board-primitives (P1)** — DELETE re-impl `CockpitPulse`/`ProjectAttentionCard` (`documents-list.client.tsx:327,356`) | `board-primitives.tsx`                            | NOW       | ⬜     |
| 3.3 | **Search/filter** — imports · messages · notes · audit (audit BE-gated rollout)                                                          | list endpoints + keyset                           | NOW       | ⬜     |
| 3.4 | **State-model on every screen × role** (catalog שלב 3) — incl. contractor/tenant/agent + share-delivery at owner-gate                    | board-primitives + ProjectPerception              | NOW       | ⬜     |

## WAVE 4 — Cross-party collaboration (Finding 3 — hard-serial 4.1→4.2→4.3; shared external_share schema)

| id  | slice · goal                                                                                                                                                                                                                         | seam                                             | now/gated                                                 | status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------- | ------ |
| 4.1 | **`party_request` entity + recipient cols + wire resolver** — recipient_name/email_enc/phone_enc/channel on external_share; `partyTypeForDocumentParty` bridge; migration 0079 RLS+FORCE                                             | `decideExternalPartyAccess` (WIRE, built)        | build NOW · prod-backfill GATED                           | ⬜     |
| 4.2 | **X-S4 party token + write-back** — `PartyTokenService` audience `emapp-party` + `PartyAuthGuard` + party read endpoint; `documents.actions.upload` cap (default OFF) + `POST /party/requests/:id/fulfill` (scope-derived auto-file) | clone `ShareTokenService`; `assertWithinCeiling` | build NOW · OTP delivery GATED                            | ⬜     |
| 4.3 | **Outbound delivery + autonomous re-chase** — realize the chase `send` thunk via `governOutboundSend`; `outbound_ledger.proposal_id` nullable + `cause` discriminator (ONE ledger); party-request-chase recommender                  | `governOutboundSend` + the ONE ledger            | **GATED** (real send) — wiring/draft NOW, kill-switch OFF | ⬜     |

---

## THE ONLY OWNER-GATED SET (prepare one-click + document, never perform, never stops the pipeline)

- **Real email/SMS to real external parties** (4.3 send · 4.2 OTP delivery · document-chase delivery) — needs
  consent registry **#512** + provider creds + kill-switch flip. _All wiring ships NOW, inert behind default-OFF._
- **Prod migrations/backfills on live data** — 4.1 existing-share recipients · #498 sensitive-doc re-encrypt
  (the open "DO NOT MERGE until prod backfill" PR). _Forward migration + dev backfill ship now._
- **Hosts-file `127.0.0.1 localhost`** (0.3) — admin OS write. _Node ipv4first flag ships now._
- **Prod deploy timing · secrets/KMS/R2 provisioning · legal/DPO sign-off.**
- **Auto-execute is NOT gated to BUILD** — per-kind org-opt-in flag (default OFF); only flipping a kind ON in prod is the owner's call.

## Coverage assertion

Every slice traces to a catalog screen (layer 16) + a table/enum (layer 5) or endpoint (layer 1) or
recommender (layer 7). The drift-guard (1.0) fails any PR adding a route/enum/recommender absent from the
catalog, so completeness is preserved automatically. C1–C12 (definition-of-perfect) is measured vs the catalog.
