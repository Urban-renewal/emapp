'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  PROVIDER_REASON_MAX_LEN,
  PROVIDER_REASON_SUBSTANTIVE_MIN_LEN,
  readProviderReason,
  setProviderReason,
  validateProviderReasonClient,
} from '@/lib/provider-reason';

/**
 * Access-reason gate — blocks the `/provider/*` subtree until the
 * Provider Admin types a reason for this session.
 *
 * Threat-model linkage (D.37):
 *  - Security: every cross-tenant request gets audited with this reason.
 *    A blank reason → BE 400 reason_required. The gate makes the
 *    operator's intent EXPLICIT (and saves a round-trip).
 *  - Performance: sessionStorage read on first render; gate disappears
 *    immediately on submit (no re-render storm).
 *  - Error handling: blank input is disabled-submit; the `set` call
 *    throws on whitespace-only (guarded by `trimmed.length`).
 *
 * UX:
 *  - Reads sessionStorage on mount; if already set, renders nothing
 *    (the page content shows directly).
 *  - On submit, persists the reason and re-renders (gateOpen=false).
 *  - D2-DEF-2: the gate enforces the SAME rule as the BE `withProvider`
 *    (`validateProviderReasonClient` — a ticket reference OR ≥20
 *    substantive chars). Previously it accepted ≥8 chars, so an 8–19-char
 *    non-ticket reason passed the gate but failed the first cross-tenant
 *    call with a generic error. Bouncing it here keeps the audit table
 *    clean and gives the operator a clear, immediate message.
 */
interface Props {
  children: React.ReactNode;
}

export function AccessReasonGate({ children }: Props) {
  const t = useTranslations('provider.gate');
  // `null` until the mount effect resolves — avoid an SSR/CSR hydration
  // mismatch where the server thinks no reason and the client thinks
  // there is one.
  const [hasReason, setHasReason] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHasReason(readProviderReason() !== null);
  }, []);

  if (hasReason === null) {
    // Pre-mount: render a minimal skeleton so the page doesn't flash.
    return <div className="min-h-[200px]" />;
  }

  if (hasReason) return <>{children}</>;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateProviderReasonClient(value);
    if (!result.ok) {
      // Mirror the BE: a ticket ref (e.g. INC-1234) OR ≥20 substantive chars,
      // and ≤512 chars (`too_long`).
      setError(
        result.code === 'too_long'
          ? t('tooLong', { max: PROVIDER_REASON_MAX_LEN })
          : t('lowQuality', { min: PROVIDER_REASON_SUBSTANTIVE_MIN_LEN }),
      );
      return;
    }
    try {
      setProviderReason(result.value);
      setHasReason(true);
    } catch {
      setError(t('failed'));
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      {/* §S5-SEC1 — method=post defense in depth so the reason never
          leaks to URL even if JS fails to hydrate (rare but the same
          posture as login/owner-new). */}
      <form method="post" action="" onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="provider-reason" className="text-sm font-medium">
            {t('label')}
          </label>
          <input
            id="provider-reason"
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder={t('placeholder')}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <Button type="submit" disabled={!validateProviderReasonClient(value).ok}>
          {t('submit')}
        </Button>
      </form>
    </div>
  );
}
