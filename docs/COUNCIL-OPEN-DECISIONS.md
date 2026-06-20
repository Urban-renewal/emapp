# Council open decisions — owner tracking

Companion to `docs/COUNCIL-DOCS-TENANTS-DECISION.html` (the full decision doc).
Records the owner's answers + the two deferred legal questions in detail, so they
are not lost. None of these block the build.

## ✅ Decided by owner (2026-06-20)

- **DPO (ממונה הגנת פרטיות) = the owner himself.** Tikkun-13's mandatory, fine-bearing
  appointment is satisfied. → every privacy decision (retention / erasure / breach SOP)
  now routes to the owner as DPO.
- **OTP + TTL (expiry) is DEFAULT-ON for every document share**, with a **settings toggle**
  to disable (per-org; optionally per-share). Most-secure default; the toggle removes the
  recipient friction for orgs that want it. (Note: this is *access* control — orthogonal to
  the byte-delivery cost rule that API decrypt-stream is sensitive-only.)

## ⏳ Deferred — real-estate-LEGAL questions (NOT privacy, NOT build-blocking). Owner will check with the יזמים/counsel.

### Open #2 — required-document checklist templates per project track
**Plain statement.** Each urban-renewal track legally requires a *different* set of documents
before a project is "ready for approval":
- **חיזוק (tama38_1)** — owners stay in place; no eviction protocol; lighter required set.
- **הריסה ובנייה (tama38_2)** — demolition; relocation/eviction arrangements become relevant.
- **פינוי-בינוי** — typically requires per-apartment eviction agreements **+** a higher
  consent threshold **+** חוק המכר bank guarantees.

**Why it needs you/counsel.** Engineering must NOT invent the legal required-set. We need the
authoritative list per track, signed off by real-estate counsel.

**What ships anyway (no block).** The completeness checklist ships **ADVISORY** immediately —
it shows "חסר: ערבות בנקאית" as guidance but does **not** auto-block the B5 `→approved` gate.
We wire it into the hard gate **only after** counsel signs the per-track templates. A
misclassified ייפוי-כוח or a draft (not executed) ערבות must never auto-advance a project past
a gate one tap — that is legal poison.

**Decision needed (later):** (a) the authoritative required set per track; (b) permission to
wire the signed templates into the hard `→approved` gate.

### Open #3 — does the post-erasure retained consent record suffice as legal proof?
**Plain statement.** When an apartment owner exercises their right to erasure ("delete my
data"), we must NOT destroy the *proof that they consented* — otherwise the evidence is gone
if the consent is later contested before the מפקח על רישום מקרקעין. So on erasure we keep a
**minimal retained record** (document hash + signed_at + auth method + owner link; the
biometric blob + signer IP/UA are redacted) and erase the personal payload.

**Why it needs you/counsel.** The only question is **legal sufficiency**: is that minimal
retained set enough to prove consent in contested litigation, or must we generate a separate
**notarized/exported evidence pack** BEFORE the redaction?

**What ships anyway (no block).** The erasure path is built documents-aware with a hard
**consent-record carve-out** (consent/signature evidence is retained, never erased on an owner
DSAR). The sufficiency sign-off only changes whether we *also* mint a pre-erasure evidence pack.

**Decision needed (later):** counsel's evidentiary sign-off (sufficient as-is / needs a
pre-erasure pack). Record the answer in `docs/DECISION-erasure-vs-legal-retention.md`.

## 🔎 Scale finding (owner asked: "are you accounting for high project scale per org?")

The board / work-queue model is the *right* answer to scale (you never browse 200 projects;
you see the ≤5 that need you). The scale burden lands entirely on the **global surfaces**
(projects list + cross-project work-queues + the org pulse); contextual in-spine collections
(a project's apartments, an apartment's owners) are naturally bounded and fine.

**Real gap found in code:** the projects-list **search is CLIENT-SIDE only** — it filters the
currently-loaded page, not the whole org (`projects-list.client.tsx` explicitly flags "a real
`?q=` server-side search needs a BE slice"). At hundreds of projects this is inadequate.

**Scale-hardening to add to the plan (not yet built):**
1. Server-side `?q=` search across projects (and the other global queues).
2. Saved filters / segments (by status, by agent, by stalled-days, by city) for a manager
   holding hundreds of projects.
3. A **seeded-500-project perf gate** on the pulse + projects-list (current perf gate is
   seeded-50); verify `signaturePulse` + `rankAttention` stay sub-second at scale.
