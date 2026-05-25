'use client';

import {
  PUBLIC_SIGN_SVG_MAX_BYTES,
  PublicSignPreviewSchema,
  PublicSignSubmitInput,
  PublicSignSubmitResponseSchema,
  type PublicSignPreview,
  type PublicSignSubmitResponse,
} from '@emapp/shared-types';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

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
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
  const [stage, setStage] = useState<Stage>('loading');
  const [preview, setPreview] = useState<PublicSignPreview | null>(null);
  const [doneAt, setDoneAt] = useState<PublicSignSubmitResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [canvasEmpty, setCanvasEmpty] = useState(true);
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

  async function onSubmit() {
    if (!canvasHandleRef.current || canvasHandleRef.current.isEmpty()) return;
    setSubmitError(null);
    const svg = canvasHandleRef.current.toSvg();
    // FE-side defensive parse against the same schema the BE pipe
    // enforces. A canvas that produced too-small / too-large SVG
    // would fail server-side too — fail-fast locally.
    const parsed = PublicSignSubmitInput.safeParse({ signatureSvg: svg });
    if (!parsed.success) {
      const code = parsed.error.issues[0]?.message ?? 'invalid';
      setSubmitError(
        code === 'signature_too_short'
          ? 'החתימה קצרה מדי. נסה חתימה מלאה יותר.'
          : code === 'signature_too_large'
            ? 'החתימה גדולה מהמותר. נסה חתימה פשוטה יותר.'
            : 'החתימה אינה תקינה.',
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
        // Anti-enumeration: any failure → generic "link no longer
        // valid" stage. We don't surface 409/410/401 differently.
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
        <p className="text-sm text-muted-foreground">טוען...</p>
      </main>
    );
  }

  if (stage === 'invalid') {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold">הקישור אינו תקף</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          הקישור לחתימה אינו זמין יותר. ייתכן שהוא פג תוקף, כבר נחתם או בוטל. צור קשר עם מנהל
          הפרויקט לקבלת קישור חדש.
        </p>
      </main>
    );
  }

  if (stage === 'done' && doneAt) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold">החתימה נקלטה בהצלחה ✓</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          תודה. החתימה נשמרה במערכת. ניתן לסגור את החלון.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          זמן שמירה:{' '}
          {new Date(doneAt.signedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}
        </p>
      </main>
    );
  }

  if (!preview) return null;

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">חתימה על מסמך</h1>
        <p className="text-sm text-muted-foreground">
          {/* preview.owner.name is wire-supplied; the bidi risk is real,
              but in this minimal layout we render it as a span without
              the dashboard's <NameDisplay> wrapper since the public
              page is a single-purpose surface. Server-side, owner
              names are sanitised before delivery. */}
          שלום <span dir="auto">{preview.owner.name}</span>, אנא קרא את המסמך וחתום למטה.
        </p>
      </header>

      <section className="space-y-2 rounded-md border bg-card p-4">
        <h2 className="text-sm font-semibold">המסמך לחתימה</h2>
        <p className="text-sm" dir="auto">
          {preview.document.name}
        </p>
        <a
          href={preview.document.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm font-medium underline"
        >
          פתח את המסמך לצפייה
        </a>
        <p className="text-xs text-muted-foreground">
          תוקף קישור החתימה:{' '}
          {new Date(preview.expiresAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">חתימה</h2>
        <p className="text-xs text-muted-foreground">
          חתום עם העכבר או האצבע במסך הלבן למטה. (עד {Math.round(PUBLIC_SIGN_SVG_MAX_BYTES / 1024)}
          KB)
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
            נקה
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={canvasEmpty || stage === 'submitting'}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {stage === 'submitting' ? 'שולח...' : 'שלח חתימה'}
          </button>
        </div>
        {submitError && <p className="text-sm text-destructive">{submitError}</p>}
      </section>
    </main>
  );
}
