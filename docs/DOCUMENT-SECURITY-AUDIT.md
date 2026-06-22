# EMAPP — Document Security Audit (red-team, full lifecycle)

> 2026-06-22, 6-agent red-team council over the full document flow vs parties (owner-mandated). Full
> output: session task `wsnhfm5jn`. Verdict: NOT production-ready — but a COUPLING DEFECT, not a מחדל.
> The isolation spine is strong (withTenant RLS FORCE, agent record-scope, fail-closed key registry,
> magic-byte+AV+finalize gates, contractor structurally-excludes-sensitive). The breakage: the PII POLICY
> flag (`documents.sensitive`) is decoupled from the STORAGE state (`documents.bytes_encrypted`), and
> several gated PII paths are bypassable.

## 🔴 LAUNCH BLOCKERS
1. **CRITICAL — sensitive≠encrypted served plaintext** (`resolveDownload` documents.service.ts:1492-1507):
   download routes on `bytes_encrypted` only; a `sensitive=true && bytes_encrypted=false` row → plain
   presign of cleartext national_id/נסח. ~750 docs / 170 orgs. = **Gate-6 PR #486** (held).
2. **CRITICAL — public-sign preview plain-presigns sensitive** (public-sign.service.ts:188-197): an
   UNAUTHENTICATED resident (`/sign/:token`) is served cleartext sensitive PII; no sensitivity branch.
3. **CRITICAL — sensitive-flip paths manufacture the plaintext state**: `remediationSweep` (:1055) +
   `update`-retype (:1748) set `sensitive:true` with NO re-encryption; `uploadContent` (:1314) is the only
   `bytes_encrypted=true` writer. Normal automation produces the dangerous state.
4. **HIGH — bulk PII export bypasses step-up** (export.controller.ts): emits cleartext national_id+phone
   for every owner, with ZERO `assertPiiUnlocked` — a bigger PII surface than any single doc, ungated.
5. **HIGH — step-up unlock decoupled from `owners.reveal_pii`** (step-up.controller.ts:24-26 = AuthGuard
   only): a **Viewer** ("PII masked, no reveal") can self-OTP and download national_id-dense docs.
6. **HIGH — presigned PUT binds no content-hash + no overwrite guard** (r2.provider getUploadUrl): a
   leaked 300s PUT URL can swap an object's bytes after AV scan (דריסה / scan-then-swap TOCTOU); finalize
   treats missing checksum as PASS.
7. **HIGH — no DB invariant couples policy↔storage** (0072 is column-only): the coupling is convention,
   not a CHECK/trigger; any future writer silently re-opens the hole.
8. **HIGH — contractor share has no expiry on retrieval**: live tier = old shares table (revoked_at only)
   + flat 30-day JWT; the new `external_shares.expires_at` (0079) has NO read-consumer.

## The correct secure flow (target)
UPLOAD: presigned PUT bound with `x-amz-checksum-sha256` + `IfNoneMatch:'*'` (create-only, single-shot,
short TTL, server-random key). STORE/finalize: re-read bytes, recompute sha256 (reject mismatch, no
"undefined=pass"), magic-byte+AV clean; sensitive types EMAPPENC-encrypted at rest BEFORE finalize —
`sensitive=true` NEVER without `bytes_encrypted=true` in the same tx. FLIP: any later sensitive-flip
re-encrypts-or-quarantines in the audited tx. ACCESS: RLS FORCE → @RequirePermission → agent record-scope
→ sensitive needs a PII step-up that is itself gated on `owners.reveal_pii`. RETRIEVE: `resolveDownload`
routes on **`sensitive`** (not bytes_encrypted) — sensitive ⇒ ALWAYS API decrypt-stream (no bearer URL
leaves the app); `sensitive && !bytes_encrypted` ⇒ hard 503 `doc_encryption_pending`. SHARE: ONE shared
party-authz resolver consumes `external_shares` (scope membership + `expires_at` every request +
`allow_sensitive` behind OTP + watermark-at-serve); contractor AND party shares route through it. DELETE:
archive over R2 Object-Lock+versioning (WORM) + legal_hold; durable audited hard-delete N days post-archive
/ on erasure; backfill covers archived rows.

## Things the owner's list didn't yet include (council surfaced)
- **Retention/erasure durability**: soft-delete leaves R2 PII bytes forever; no hard-delete job, no
  right-to-erasure path, no `legal_hold` to BLOCK deletion of a disputed doc.
- **R2 Object-Lock (WORM) + versioning** not configured — the app is the ONLY tamper/delete defense for
  legally-binding agreements + signed PDFs.
- **Signed-document immutability**: a signature attests `documentHash` but nothing freezes the bytes — an
  owner can be shown they "signed" content that was later overwritten (legal-evidence gap).
- **Leaked-key blast radius is fleet-wide**: one global `DOC_ENCRYPTION_KEY` decrypts every sensitive doc
  in all 170 orgs offline; no per-org DEK/KEK isolation; rotation only re-stamps NEW objects.
- **Presigned-URL revocation latency**: revoke is immediate for API but a minted URL lives its full TTL in R2.
- **external_shares is a DEAD control surface**: `expires_at/otp_required/allow_sensitive/watermark` are
  persisted + ceiling-validated but have NO read-consumer — they LOOK enforced; a naive future consumer is the risk.
- **decrypt-stream buffers full plaintext in heap** — availability/DoS angle under a download burst.
- **No per-recipient watermark** on served sensitive bytes — a leaked נסח is unattributable.

## Hardening roadmap (blockers first, reuse-first)
B1 (#486, FIRST): `resolveDownload`+`getDownloadUrl` branch on `sensitive`; `sensitive&&!encrypted`→503;
sensitive serves only via `getDecryptedStream`. · B2: sensitive-flip re-encrypts (sweep+retype). · B3:
backfill re-encrypt ~750 (incl. archived) + DB CHECK + CI data-audit. · B4: public-sign preview select
sensitive + reject sensitive on the public surface. · B5: gate StepUpController on
`@RequirePermission('owners.reveal_pii')` (+ assert in `assertPiiUnlocked`). · B6: export requires
`assertPiiUnlocked` for PII columns (+ split `export.run.pii`). · B7: presigned PUT `IfNoneMatch:'*'` +
checksum binding + finalize-once. · H1: ONE shared external-party authz resolver (scope+expiry+OTP+
watermark+decrypt-stream) before the binder share endpoint; add `expires_at` enforcement to the live
shares tier now. · H2: envelope per-org DEK/KEK (KMS). · H3: tighter step-up TTL + per-project scope +
bulk-download anomaly alert; shorter temp-link TTL. · H4: R2 Object-Lock+versioning + freeze-on-sign. ·
H5: retention/erasure hard-delete + legal_hold; bound decrypt-stream concurrency.

## First action (urgent)
B1 — make `resolveDownload` fail-closed on the coupling (route on `sensitive`, decrypt-stream only, hard
503 for sensitive&&!encrypted, NEVER plain-presign) + the same in public-sign preview. This stops serving
cleartext national_id/נסח on BOTH the org and the unauthenticated-resident surfaces. It is Gate-6 #486 —
note the trade-off: fail-closed BEFORE the backfill 503s the ~750 plaintext docs (no leak, but broken
downloads) → must be coordinated with the backfill, an OWNER Gate-6 timing decision.

## Split: what's owner-gated vs buildable-now
- **Gate-6 / owner-coordinated (#486 family — B1/B2/B3/B4):** the coupling + re-encrypt-on-flip + the
  170-org backfill + the DB constraint. Already built+held as #486; needs the fail-closed-vs-503 timing call.
- **Buildable NOW (no migration, no backfill, @security-reviewed, held PRs):** B5 step-up→reveal_pii gate ·
  B6 export step-up · B7 presigned-PUT hardening · H1-partial contractor share expiry enforcement.

## B7/#500 red-team finding (2026-06-22) — "cosmetic control" CRITICAL caught
The first B7 build (PR #500) passed its own @security but an INDEPENDENT red-team found the
anti-overwrite control was COSMETIC: `getUploadUrl` set `IfNoneMatch:'*'` + `ChecksumSHA256` on the
`PutObjectCommand` but presigned with default `getSignedUrl` options — so those request headers are
NOT in the URL's `X-Amz-SignedHeaders`, R2 never requires them, and a leaked URL can still overwrite
by simply omitting them. VERIFIED against r2.provider.ts:132. REUSABLE GOTCHA: presigned-PUT custom
headers (If-None-Match, x-amz-checksum-sha256) are only enforced if passed via `signableHeaders`
(+ checksum in `unhoistableHeaders`) to getSignedUrl AND the upload client SENDS them — and a test
must assert the SIGNED URL carries them, not just that the command object does (asserting the SDK
input ≠ asserting the security property — a D.51 anti-plaster signal). Also found: finalize-once was
a check-then-act TOCTOU (SELECT-then-unconditional-UPDATE under READ COMMITTED) → must be an atomic
`UPDATE ... WHERE uploaded_at IS NULL RETURNING`. Both in fix (agent ace0925587385b72b); re-red-team after.
