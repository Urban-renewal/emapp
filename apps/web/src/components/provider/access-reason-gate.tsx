'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { readProviderReason, setProviderReason } from '@/lib/provider-reason';

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
 *  - Minimum length 8 chars enforced FE-side — same posture as the
 *    BE's `provider_audit_log.reason` non-empty check; bouncing
 *    short/junk reasons at the gate avoids polluting the audit table.
 */
interface Props {
  children: React.ReactNode;
}

const MIN_LENGTH = 8;

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
    const trimmed = value.trim();
    if (trimmed.length < MIN_LENGTH) {
      setError(t('tooShort', { min: MIN_LENGTH }));
      return;
    }
    try {
      setProviderReason(trimmed);
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
        <Button type="submit" disabled={value.trim().length < MIN_LENGTH}>
          {t('submit')}
        </Button>
      </form>
    </div>
  );
}
