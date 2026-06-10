# DECISION (RECOMMENDATION) — e-signature legal validity tier

> Status: **RECOMMENDATION — owner + legal counsel must confirm.** 2026-06-10.
> Written per the owner directive "go with my recommendation + document." This is a
> business/legal call I cannot finalize alone; it records the analysis + the
> recommended path so the owner decides with eyes open. NOT a code change.

## The question

EMAPP collects apartment-owner **consent signatures** for תמ"א 38 / פינוי-בינוי.
Those consents are the legal foundation of the project (the thresholds that can
compel hold-out owners) and are routinely litigated by opposing owners — where the
contested fact is usually **"did THIS owner really consent?"** (identity), not
whether the document changed. What evidentiary tier does our signature meet?

## Israeli law — the three tiers (Electronic Signature Law, 5761-2001)

1. **Simple** electronic signature — admissible, but weight "depends on the
   circumstances" (contestable).
2. **Secure** (חתימה מאובטחת) — prima-facie evidence the document was not altered
   after signing + was made with the signer's signing device. **NOT** prima-facie
   proof of identity.
3. **Certified** (חתימה מאושרת, issued by a licensed Certification Authority) —
   the only tier that is prima-facie proof of the **signer's identity**; legally
   equivalent to a wet signature.

## What EMAPP produces today — a SIMPLE signature (weakest tier)

- A drawn-SVG + a SHA-256 document hash + an internally-generated certificate
  (`pdf-signed-document.renderer.ts`), `authMethod: 'public_link_v1'`.
- **Identity binding is weak:** the sign endpoint requires only possession of the
  bearer link (`public-sign.controller.ts`) — no identity verification on the sign
  path. The document hash gives _integrity_, but nothing proves _who_ signed.
- This is **legally permissible** (post-2018, e-signatures suffice for most
  documents) but sits at the weakest evidentiary tier exactly where we most need to
  prove identity.

## Recommendation (for owner + counsel)

**Tier target: strengthen toward "secure" on integrity (largely already there) AND
materially strengthen IDENTITY BINDING now; reserve a "certified"/notarized path for
the formal threshold consents.** Concretely, in priority order:

1. **Bind identity at signing (highest ROI, buildable):** require the resident to
   pass an **SMS-OTP verification of their registered phone BEFORE the signature is
   accepted** (not just hold the link). This ties each signature to a verified phone
   number on record — a large evidentiary jump from a bare bearer link, at low cost,
   reusing the existing tenant-OTP infrastructure. Record the OTP-verification event
   - phone on the signature provenance. _(This is the single most important upgrade;
     it is also a DEFERRED-to-pre-prod item because it depends on live SMS — see the
     gap-hunt. Sequence it with live-SMS verification.)_
2. **Preserve + surface the integrity tier:** the document hash + signed-event +
   immutable audit already support the "secure" _integrity_ axis — keep the signed
   certificate showing the hash + timestamp + auth method.
3. **For the formal legal-threshold consents** (the ones used to compel hold-outs):
   counsel should decide whether a **CA-certified signature** (Israel's QES
   equivalent) or **notarization** is required for those specific documents. This is
   a per-document-class legal call, not a blanket platform change.

## Why not "just go certified for everything"

CA-certified signatures add friction (each signer needs a certificate) that would
crater resident completion rates for routine consents. The proportionate posture is:
**strong identity binding (OTP) for all signatures, certified/notarized only for the
high-stakes threshold documents** where counsel says the evidentiary bar demands it.

## Owner action

- Confirm the tier strategy above (or direct otherwise) with legal counsel.
- If approved, the OTP-at-signing upgrade (#1) becomes a pre-production build item,
  sequenced with live-SMS verification.

## Sources

- Electronic Signature Law, 5761-2001 (the three tiers + 2018 amendment).
- Adobe / DocuSign Israel e-signature legality summaries.
