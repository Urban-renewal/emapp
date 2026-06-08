# C2 (audit M3) — import set-replace end-dating is by-design + preview-mitigated

**Finding (AUTONOMOUS-BACKLOG C2 · M3):** "import set-replace silently end-dates
pre-existing owners (by-design D.25, mitigated by preview). Verify; likely
document-only, maybe a confirm-copy."

**Verification result: WORKING AS DESIGNED — not silent. No code fix required.**

## What the behaviour is

An owner-set import in **replace** mode reconciles each apartment's owner roster
to the imported set: owners present before the import but absent from the
imported set are **end-dated** (soft-removed), not hard-deleted. This is the
intended D.25 semantics — an import is the authoritative new state of who owns
what, so removing-by-omission is the point of replace mode.

## Why it is NOT "silent" (the safeguard)

The import is a **two-phase preview→confirm** flow (`imports.service.ts`,
migration 0048):

1. The upload is parsed and validated into a **preview** with
   `status = 'awaiting_confirm'` — nothing is written to the live owner roster yet.
2. The manager reviews the preview (the computed diff, including which existing
   rows will be added / changed / removed) and must **explicitly confirm** before
   the reconciliation is applied. A bad import is **cancellable/discardable** at
   this stage (the "discard a bad import" path) with zero effect on live data.

So the end-dating is surfaced to and **explicitly authorized by** the manager
before it happens — it is not a silent side effect. The preview is the D.25
mitigation the finding refers to, and it is present and enforced.

## Authorization

The import + confirm path is manager/admin-capability-gated and org-scoped via
`withTenant` (same posture as the rest of the imports module). A Viewer/Agent
without the import capability cannot trigger a replace.

## Optional future enhancement (NOT done here — not required to close C2)

The preview already lists the affected rows. A small UX nicety would be an
explicit count line in the confirm step — e.g. "N existing owners will be
removed from their apartments" — to make the removal even more prominent than
the per-row diff. This is a copy-only enhancement, not a correctness/security
gap, and is left as a candidate for the design re-skin (owner-dependent).

## Conclusion

C2 is **closed as document-only**: the behaviour is intentional (D.25), is gated
behind an explicit manager preview→confirm (so it is not silent), and is
org-scoped + capability-gated. No code change is warranted. Optionally add a
confirm-step count line during the design pass.
