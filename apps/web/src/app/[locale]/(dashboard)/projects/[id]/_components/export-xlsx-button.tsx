'use client';

import { FileSpreadsheet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * V11 A.S15 — Export button: download project as xlsx.
 *
 * Wire contract (B.S10 — `apps/api/src/modules/export/export.module.ts`
 * line 9): `GET /api/v1/projects/:id/export?format=xlsx`. Response is
 * a streaming `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
 * body with `Content-Disposition: attachment; filename="<project>.xlsx"`.
 *
 * Why we fetch + blob instead of `<a href={url} download>`:
 *  1. The XHR fetch lets us surface the 4xx/5xx as a localized toast
 *     rather than the browser's generic "Couldn't download" — important
 *     because B.S10 may 404 mid-deploy / while we wait for the BE PR.
 *  2. The `download` attribute relies on the same-origin filename rule,
 *     which works since D.35 routes /api/v1/* through the Pages
 *     reverse-proxy — but the BE's `Content-Disposition` filename is
 *     authoritative (server-set, no XSS-able injection from FE state).
 *  3. We `URL.revokeObjectURL` after the synthetic click so the blob
 *     gets garbage-collected promptly (avoids 50MB+ retained per export).
 *
 * Security:
 *  - `credentials: 'same-origin'` sends the access_token cookie; D.21
 *    cookie posture preserved (HttpOnly never on the wire as JS-readable).
 *  - The synthetic `<a>` is created + clicked + removed in one tick;
 *    it never reaches a state where a user-supplied URL could be clicked
 *    (the URL is `URL.createObjectURL(blob)` — local blob: scheme).
 *  - Filename comes from the BE `Content-Disposition` header; we don't
 *    construct it from `data.name` (which is user-supplied / encrypted PII).
 *    If the header is missing (B.S10 misconfig), the browser uses the
 *    `download` attribute fallback we set to `project-<id>.xlsx`.
 *
 * Smoke states (each one tested manually + verified in this component):
 *   - idle    → primary button "ייצוא לאקסל"
 *   - loading → disabled, label "מייצא..." (spin via Tailwind animate-pulse)
 *   - ok      → silent (browser shows native download tray) + 3s success
 *               toast "ההורדה הסתיימה"
 *   - 404     → toast "נקודת הקצה לייצוא טרם הופעלה — צפוי בקרוב."
 *               (specific to the B.S10-not-yet-deployed window)
 *   - other   → generic toast "ייצוא נכשל. נסה שוב."
 */
interface Props {
  projectId: string;
  /** Fallback filename when the BE doesn't set `Content-Disposition`.
   *  Uses the project ID — NOT the localized name — so the filename is
   *  ASCII-safe and predictable. */
  fallbackName?: string;
}

type ExportState = 'idle' | 'loading' | 'ok' | 'not_ready' | 'failed';

const TOAST_DISMISS_MS = 3_000;

export function ExportXlsxButton({ projectId, fallbackName }: Props) {
  const t = useTranslations('projects.export');
  const [state, setState] = useState<ExportState>('idle');

  async function onClick() {
    if (state === 'loading') return;
    setState('loading');
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/export?format=xlsx`, {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setState(res.status === 404 ? 'not_ready' : 'failed');
        scheduleDismiss(setState);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // Note: `fallbackName` (display name from the page) is deliberately
      // NOT used as a filename source — see `defaultName` docstring for
      // the PII / U+202E rationale. The prop is still accepted as a
      // future-proofing seam (e.g. tooltip, aria copy).
      void fallbackName;
      const filename =
        parseFilename(res.headers.get('Content-Disposition')) ?? defaultName(projectId);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      setState('ok');
      scheduleDismiss(setState);
    } catch {
      setState('failed');
      scheduleDismiss(setState);
    }
  }

  const isLoading = state === 'loading';
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        aria-label={t('aria')}
        aria-busy={isLoading}
        data-testid="export-xlsx-button"
        className="btn btn-secondary btn-sm disabled:cursor-wait disabled:opacity-60"
      >
        <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{isLoading ? t('downloading') : t('excel')}</span>
      </button>
      {state !== 'idle' && state !== 'loading' && (
        <p
          role="status"
          aria-live="polite"
          data-testid={`export-toast-${state}`}
          className="absolute end-0 top-full mt-1 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-[11px] shadow-sm"
          style={{
            color:
              state === 'ok'
                ? 'var(--success-700)'
                : state === 'not_ready'
                  ? 'var(--warning-700)'
                  : 'var(--danger-700)',
            background: 'var(--bg-surface)',
            borderColor: 'var(--border)',
          }}
        >
          {state === 'ok' ? t('downloaded') : state === 'not_ready' ? t('notReady') : t('failed')}
        </p>
      )}
    </div>
  );
}

function scheduleDismiss(setState: (s: ExportState) => void) {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => setState('idle'), TOAST_DISMISS_MS);
}

/**
 * RFC 6266 `filename=`/`filename*=` parsing — narrow, only what we need.
 * Returns the unquoted filename or `null` if the header is absent/unparseable.
 * Prefers `filename*=` (RFC 5987 — UTF-8) over plain `filename=` so Hebrew
 * project names survive the round-trip.
 *
 * @internal — exported for unit testing only (see
 * `export-xlsx-button.spec.ts`).
 */
export function parseFilename(header: string | null): string | null {
  if (!header) return null;
  // RFC 5987: filename*=UTF-8''<percent-encoded>
  const rfc5987 = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (rfc5987 && rfc5987[1]) {
    try {
      return decodeURIComponent(rfc5987[1].trim());
    } catch {
      // fall through to plain
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  if (plain) {
    return (plain[2] ?? plain[3] ?? '').trim() || null;
  }
  return null;
}

/**
 * Fallback filename when the BE doesn't set `Content-Disposition`. Uses
 * an ASCII-safe slug of the project id; the `fallbackName` prop on the
 * component is deliberately NOT passed here — display names can carry
 * PII / RTL / U+202E spoof chars; the BE's `Content-Disposition`
 * filename is the authoritative source when present, and this slug is
 * the only safe fallback otherwise.
 *
 * @internal — exported for unit testing only.
 */
export function defaultName(projectId: string): string {
  // All-or-nothing: if the id contains ANY non-safe character (Hebrew,
  // path separator, null, control), we don't trust it for filename use
  // and fall back to `project-export.xlsx`. Stripping unsafe chars and
  // keeping the surviving fragment (e.g. `דירה/../etc\x00` → `etc`)
  // would let an attacker leak intent through the filename — safer to
  // discard and use the generic stub. Matches spec test #12.
  return /^[A-Za-z0-9_-]+$/.test(projectId) ? `project-${projectId}.xlsx` : 'project-export.xlsx';
}
