'use client';

import {
  PUBLIC_SIGN_SVG_MAX_BYTES,
  PublicSignPreviewSchema,
  PublicSignSubmitInput,
  PublicSignSubmitResponseSchema,
  type PublicSignPreview,
  type PublicSignSubmitResponse,
} from '@emapp/shared-types';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { NameDisplay } from '@/components/ui/name-display';

import { SignatureCanvas, type SignatureCanvasHandle } from './_signature-canvas';

/**
 * S10 — public residents' signing page (D.12 LAW).
 *
 * Security posture:
 *  - The JWT is the only credential. NEVER stored in localStorage or
 *    cookies on the FE — it lives only in `useParams()` for the
 *    duration of this page.
 *  - Anti-enumeration: every error from GET/POST collapses to a single
 *    "link no longer valid" UX so an attacker can't distinguish
 *    expired vs cancelled vs forged vs already-signed. The BE
 *    already returns generic 401 `invalid_token`; we mirror that
 *    posture on the FE error rendering.
 *  - Atomic single-use: handled BE-side via the `WHERE jti AND
 *    status='pending'` UPDATE. A successful POST returns `signedAt`
 *    confirmation; subsequent retries return 401 invalid_token →
 *    same generic UX.
 *  - Defensive parse: every wire response goes through Zod before the
 *    UI sees it.
 */

const PreviewData = z.object({ data: PublicSignPreviewSchema });
const SubmitData = z.object({ data: PublicSignSubmitResponseSchema });

type Stage = 'loading' | 'preview' | 'submitting' | 'done' | 'invalid';

export default function SignPage() {
  const t = useTranslations('sign');
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
  const [stage, setStage] = useState<Stage>('loading');
  const [preview, setPreview] = useState<PublicSignPreview | null>(null);
  const [doneAt, setDoneAt] = useState<PublicSignSubmitResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [canvasEmpty, setCanvasEmpty] = useState(true);
  // P0.C2 — explicit PII-processing consent. Only GATES the Submit button when
  // the org sets `requireExplicitConsent`; otherwise consent is recorded
  // implicitly-by-signing and this checkbox is not shown.
  const [consentChecked, setConsentChecked] = useState(false);
  // Inline-preview load failure (PDF blocked by browser sandbox / R2
  // outage / unsupported viewer) → fall back to the "open in new tab"
  // affordance so the resident can still READ before they sign.
  const [previewFailed, setPreviewFailed] = useState(false);
  const canvasHandleRef = useRef<SignatureCanvasHandle | null>(null);

  const setHandle = useCallback((h: SignatureCanvasHandle | null) => {
    canvasHandleRef.current = h;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!token) {
        setStage('invalid');
        return;
      }
      try {
        const res = await fetch(`/api/v1/sign/${encodeURIComponent(token)}`, {
          // No credentials — this is an unauthenticated endpoint and
          // we don't want any cookies (manager session, marketing, etc)
          // sent over the public-link wire.
          credentials: 'omit',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          if (!cancelled) setStage('invalid');
          return;
        }
        const body = await res.json();
        const parsed = PreviewData.safeParse(body);
        if (!parsed.success) {
          if (!cancelled) setStage('invalid');
          return;
        }
        if (!cancelled) {
          setPreview(parsed.data.data);
          setStage('preview');
        }
      } catch {
        if (!cancelled) setStage('invalid');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // P0.C2 — when the org requires explicit consent, the resident must tick the
  // box before signing. Derived from the preview's `consentNotice`.
  const requireExplicit = preview?.consentNotice?.requireExplicitConsent ?? false;
  const consentSatisfied = !requireExplicit || consentChecked;

  async function onSubmit() {
    if (!canvasHandleRef.current || canvasHandleRef.current.isEmpty()) return;
    if (requireExplicit && !consentChecked) {
      setSubmitError(t('consentRequired'));
      return;
    }
    setSubmitError(null);
    const svg = canvasHandleRef.current.toSvg();
    // FE-side defensive parse against the same schema the BE pipe
    // enforces. A canvas that produced too-small / too-large SVG
    // would fail server-side too — fail-fast locally.
    const parsed = PublicSignSubmitInput.safeParse({
      signatureSvg: svg,
      // Implicit-by-signing orgs send `true` too — the resident IS
      // acknowledging by signing; the BE records it either way.
      acknowledgeConsent: requireExplicit ? consentChecked : true,
    });
    if (!parsed.success) {
      const code = parsed.error.issues[0]?.message ?? 'invalid';
      setSubmitError(
        code === 'signature_too_short'
          ? t('errorTooShort')
          : code === 'signature_too_large'
            ? t('errorTooLarge')
            : t('errorInvalid'),
      );
      return;
    }
    setStage('submitting');
    try {
      const res = await fetch(`/api/v1/sign/${encodeURIComponent(token)}`, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        // P0.C2 — a 400 `consent_required` is recoverable in-place (tick the
        // box + retry); it is NOT an enumeration oracle (only reachable after
        // the token validated server-side). Surface it inline and stay on the
        // preview stage. Every OTHER failure collapses to the generic "link no
        // longer valid" stage (anti-enumeration: expired/cancelled/forged/
        // already-signed are indistinguishable).
        if (res.status === 400) {
          const body = await res.json().catch(() => null);
          const code = (body as { error?: { code?: string } } | null)?.error?.code;
          if (code === 'consent_required') {
            setStage('preview');
            setSubmitError(t('consentRequired'));
            return;
          }
        }
        setStage('invalid');
        return;
      }
      const body = await res.json();
      const ok = SubmitData.safeParse(body);
      if (!ok.success) {
        setStage('invalid');
        return;
      }
      setDoneAt(ok.data.data);
      setStage('done');
    } catch {
      setStage('invalid');
    }
  }

  if (stage === 'loading') {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </main>
    );
  }

  if (stage === 'invalid') {
    // Recovery affordance (P4 #8). Anti-enumeration is PRESERVED: the
    // copy below never discloses WHY the token failed (expired vs
    // cancelled vs forged vs already-signed all reach this same block).
    // The recovery path is generic — log into the resident portal and
    // self-resend a fresh link (B-RESIDENT-1: POST /portal/signatures/
    // :id/resend) — and reveals nothing about the failed token.
    //
    // The /sign route is locale-LESS; residents are Hebrew-default, so
    // we link to the he-prefixed tenant login (it lives under [locale]).
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold">{t('invalidTitle')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('invalidBody')}</p>
        <p className="mt-4 text-sm text-muted-foreground">{t('invalidRecoveryHint')}</p>
        <Link
          href="/he/tenant/login"
          className="mt-3 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          {t('invalidRecoveryCta')}
        </Link>
        <p className="mt-3 text-xs text-muted-foreground">{t('invalidContactManager')}</p>
      </main>
    );
  }

  if (stage === 'done' && doneAt) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold">{t('doneTitle')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('doneBody')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('doneSavedAt', {
            when: new Date(doneAt.signedAt).toLocaleString('he-IL', {
              timeZone: 'Asia/Jerusalem',
            }),
          })}
        </p>
      </main>
    );
  }

  if (!preview) return null;

  // §RED-1 defense-in-depth — the wire schema already pins downloadUrl to
  // `HttpsUrlSchema`, but we re-verify the protocol here before we EMBED
  // or LINK it. A javascript:/data: URL that slipped past the schema
  // would be an embedding/click XSS vector. `safeDocUrl` is the SINGLE
  // value used by both the inline preview AND the open-in-new-tab link —
  // one source, and it is exactly the document this token authorizes
  // (the BE presigns the doc bound to signatureRequests.documentId,
  // matched against the JWT claim; the FE never widens that scope).
  const safeDocUrl = /^https:\/\//i.test(preview.document.downloadUrl)
    ? preview.document.downloadUrl
    : null;

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">
          {/* §RED-2 / §SEC-M2 / §SOLID-H2 — greeting uses next-intl rich
              messages so the owner-name (wrapped in NameDisplay for bidi
              defense) can be interpolated into the localised string.
              The callback MUST accept a `chunks` parameter so next-intl
              treats it as a rich-text tag function (it inspects arity
              via fn.length === 1 to distinguish tag callbacks from
              plain value callbacks). With `() =>` the function was
              passed to React as a raw value, triggering the
              "Functions are not valid as a React child" runtime error
              and breaking the entire signing-preview render (caught by
              the §P0-3 console-clean Playwright guardrail in PR #57).
              The `chunks` arg is the inner content of the `<name>`
              tag from the i18n message; we intentionally drop it
              because NameDisplay renders its own text from the
              `name` prop. */}
          {t.rich('greeting', {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required for next-intl arity detection
            name: (_chunks) => <NameDisplay name={preview.owner.name} />,
          })}
        </p>
      </header>

      <section className="space-y-2 rounded-md border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('documentSectionTitle')}</h2>
        <p className="text-sm">
          <NameDisplay name={preview.document.name} />
        </p>

        {/* #10 — INLINE PREVIEW. A resident must SEE the legal document
            before drawing a signature (trust + legal soundness). We embed
            the token-scoped presigned URL directly above the canvas so the
            doc is on-screen, not one click away.

            Sandbox posture: `sandbox` with NO `allow-scripts` /
            `allow-same-origin` / `allow-forms` flags — the embedded PDF
            renders as an inert document; it cannot run script, read this
            origin, or submit forms back. If the browser refuses to render
            the PDF inline (some mobile browsers, or an R2 hiccup) the
            `onError` handler flips to the new-tab fallback below. */}
        {safeDocUrl ? (
          <figure className="space-y-1">
            <figcaption className="text-xs font-medium text-muted-foreground">
              {t('previewTitle')}
            </figcaption>
            {previewFailed ? (
              <p className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                {t('previewUnavailable')}
              </p>
            ) : (
              <iframe
                src={safeDocUrl}
                title={t('previewTitle')}
                sandbox=""
                referrerPolicy="no-referrer"
                onError={() => setPreviewFailed(true)}
                className="h-[28rem] w-full rounded-md border bg-white"
              />
            )}
          </figure>
        ) : null}

        {/* Open-in-new-tab affordance — kept as the canonical "read the
            full document" action AND the fallback when inline embedding
            isn't possible. Uses the SAME re-verified `safeDocUrl`. */}
        {safeDocUrl ? (
          <a
            href={safeDocUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm font-medium underline"
          >
            {previewFailed ? t('openDocumentNewTab') : t('openDocument')}
          </a>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t('linkExpires', {
            when: new Date(preview.expiresAt).toLocaleString('he-IL', {
              timeZone: 'Asia/Jerusalem',
            }),
          })}
        </p>
      </section>

      {/* P0.C2 — PII-processing privacy notice. The org's CONFIGURABLE notice
          text (resolved server-side from OrgSettings.privacy) is shown to the
          resident before they sign. When the org requires explicit consent a
          checkbox gates the Submit button; otherwise a clear
          "by signing you acknowledge…" line records implicit-by-signing
          consent. The notice text comes from our own API (Zod-parsed) — it is
          org-authored copy, not arbitrary user input — and is rendered as plain
          text (no dangerouslySetInnerHTML). */}
      <section className="space-y-2 rounded-md border bg-muted/20 p-4">
        <h2 className="text-sm font-semibold">{t('consentSectionTitle')}</h2>
        <p className="whitespace-pre-line text-xs text-muted-foreground">
          {preview.consentNotice?.text}
        </p>
        {requireExplicit ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => {
                setConsentChecked(e.target.checked);
                if (e.target.checked) setSubmitError(null);
              }}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>{t('consentCheckboxLabel')}</span>
          </label>
        ) : (
          <p className="text-xs font-medium">{t('consentImplicitLine')}</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('signatureSectionTitle')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('signatureHint', { kb: Math.round(PUBLIC_SIGN_SVG_MAX_BYTES / 1024) })}
        </p>
        <SignatureCanvas
          width={600}
          height={240}
          canvasRef={setHandle}
          onChange={(isEmpty) => setCanvasEmpty(isEmpty)}
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => canvasHandleRef.current?.clear()}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            {t('clear')}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={canvasEmpty || !consentSatisfied || stage === 'submitting'}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {stage === 'submitting' ? t('submitting') : t('submit')}
          </button>
        </div>
        {submitError && <p className="text-sm text-destructive">{submitError}</p>}
      </section>
    </main>
  );
}
