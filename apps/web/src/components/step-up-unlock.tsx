'use client';

/**
 * 7c F1 — the reusable PII step-up unlock modal (D-P5.5/7/8).
 *
 * `useStepUpUnlock()` is the ONE seam any caller uses around a privileged
 * fetch. When the wrapped action throws the DISTINCT 403
 * `pii_step_up_required` (and ONLY that code — a plain `forbidden` is a
 * permissions error and must never open an OTP prompt), the hook opens the
 * dialog, walks the request→type-code→verify flow, and on success RETRIES
 * the original action once.
 *
 * Usage:
 *   const stepUp = useStepUpUnlock();
 *   ...
 *   try {
 *     const out = await stepUp.withStepUp(() => privilegedCall());
 *   } catch (e) {
 *     if (isStepUpCancelled(e)) return; // user dismissed — not an error
 *     ...
 *   }
 *   ...
 *   return <>... {stepUp.dialog}</>;
 *
 * No dialog/toast primitive exists in this repo (see ExportXlsxButton /
 * ProjectDocumentUpload) — this is the first true modal; it follows the
 * same inline-status conventions (role="status" lines, var(--danger-700)
 * palette, no toast lib).
 *
 * Security:
 *  - The dev/QA `data.code` exposure is never read — the user always types
 *    the code (see lib/api/step-up.ts).
 *  - Wrong-code feedback is REMAINING-ATTEMPTS-AGNOSTIC by design: one
 *    generic "wrong or expired" message regardless of the lockout counter.
 *  - 429 (per-IP throttle) → "try again later", no retry-after detail.
 *  - The <form> carries method="post" (P0 §S1-SEC1 — a pre-hydration native
 *    submit must never put the OTP code in a GET URL).
 */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ApiClientError } from '@/lib/api/errors';
import {
  isStepUpRequired,
  RATE_LIMITED_CODE,
  requestStepUpCode,
  verifyStepUpCode,
} from '@/lib/api/step-up';

/** Thrown by `withStepUp` when the user dismisses the dialog. Callers treat
 *  it as "do nothing" (NOT a failure toast/line). */
export class StepUpCancelledError extends Error {
  constructor() {
    super('step-up unlock cancelled by user');
    this.name = 'StepUpCancelledError';
  }
}

export function isStepUpCancelled(e: unknown): boolean {
  return e instanceof StepUpCancelledError;
}

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
}

export interface StepUpUnlock {
  /** Run `action`; on 403 `pii_step_up_required` open the unlock dialog and,
   *  after a successful verify, retry `action` ONCE. Any other error (and the
   *  retry's own outcome) propagates to the caller unchanged. Dismissing the
   *  dialog rejects with `StepUpCancelledError`. */
  withStepUp: <T>(action: () => Promise<T>) => Promise<T>;
  /** Imperatively open the unlock dialog (no wrapped action). Resolves once
   *  verified; rejects with `StepUpCancelledError` on dismiss. */
  requestUnlock: () => Promise<void>;
  /** Render this once in the caller's tree (returns null while closed). */
  dialog: ReactNode;
}

export function useStepUpUnlock(): StepUpUnlock {
  const [open, setOpen] = useState(false);
  // All concurrent callers behind ONE dialog share the same verify outcome.
  const waitersRef = useRef<Waiter[]>([]);

  const requestUnlock = useCallback((): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      waitersRef.current.push({ resolve, reject });
      setOpen(true);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    const waiters = waitersRef.current;
    waitersRef.current = [];
    setOpen(false);
    for (const w of waiters) {
      if (ok) w.resolve();
      else w.reject(new StepUpCancelledError());
    }
  }, []);

  const withStepUp = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (e) {
        if (!isStepUpRequired(e)) throw e;
        await requestUnlock(); // throws StepUpCancelledError on dismiss
        return action(); // retry once — its outcome propagates as-is
      }
    },
    [requestUnlock],
  );

  const dialog = (
    <StepUpDialog open={open} onVerified={() => settle(true)} onCancel={() => settle(false)} />
  );

  return { withStepUp, requestUnlock, dialog };
}

type Stage = 'explain' | 'code';
type Pending = 'idle' | 'requesting' | 'verifying';

export function StepUpDialog({
  open,
  onVerified,
  onCancel,
}: {
  open: boolean;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('stepUp');
  const [stage, setStage] = useState<Stage>('explain');
  const [pending, setPending] = useState<Pending>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset the flow whenever the dialog (re-)opens.
  useEffect(() => {
    if (open) {
      setStage('explain');
      setPending('idle');
      setCode('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function onSendCode() {
    if (pending !== 'idle') return;
    setError(null);
    setPending('requesting');
    try {
      await requestStepUpCode();
      setStage('code');
    } catch (e) {
      setError(
        e instanceof ApiClientError && e.code === RATE_LIMITED_CODE
          ? t('rateLimited')
          : t('requestFailed'),
      );
    } finally {
      setPending('idle');
    }
  }

  async function onVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending !== 'idle') return;
    if (!/^\d{6}$/.test(code)) {
      setError(t('invalidCode'));
      return;
    }
    setError(null);
    setPending('verifying');
    try {
      await verifyStepUpCode(code);
      onVerified();
    } catch (err) {
      // Remaining-attempts-agnostic by design: any verify rejection (wrong,
      // expired, burned) shows the SAME generic message. Only the throttle
      // gets its own copy.
      setError(
        err instanceof ApiClientError && err.code === RATE_LIMITED_CODE
          ? t('rateLimited')
          : t('invalidCode'),
      );
      setCode('');
    } finally {
      setPending('idle');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-dialog-title"
      data-testid="step-up-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop — click dismisses (same semantics as the Cancel button). */}
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-lg">
        <h2 id="step-up-dialog-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('explain')}</p>

        {stage === 'explain' && (
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} data-testid="step-up-cancel">
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={onSendCode}
              disabled={pending !== 'idle'}
              aria-busy={pending === 'requesting'}
              data-testid="step-up-send-code"
            >
              {pending === 'requesting' ? t('sending') : t('sendCode')}
            </Button>
          </div>
        )}

        {stage === 'code' && (
          <form method="post" onSubmit={onVerify} className="space-y-3">
            <p className="text-sm">{t('codeSent')}</p>
            <label htmlFor="step-up-code" className="block text-sm font-medium">
              {t('codeLabel')}
            </label>
            <input
              id="step-up-code"
              name="step-up-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              dir="ltr"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              disabled={pending !== 'idle'}
              data-testid="step-up-code-input"
              className="w-full rounded-md border bg-background px-3 py-2 text-center text-lg tracking-[0.5em]"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onCancel}
                data-testid="step-up-cancel"
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={pending !== 'idle' || code.length !== 6}
                aria-busy={pending === 'verifying'}
                data-testid="step-up-verify"
              >
                {pending === 'verifying' ? t('verifying') : t('verify')}
              </Button>
            </div>
          </form>
        )}

        {error && (
          <p
            role="alert"
            data-testid="step-up-error"
            className="text-sm"
            style={{ color: 'var(--danger-700)' }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
