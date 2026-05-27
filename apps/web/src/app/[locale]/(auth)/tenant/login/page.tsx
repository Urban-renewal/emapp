'use client';

import {
  OtpRequestSchema,
  OtpVerifySchema,
  type OtpRequestDto,
  type OtpVerifyDto,
} from '@emapp/shared-types';
import { isValidIsraeliPhone } from '@emapp/validators';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

/**
 * V11 A.S14a + external-services-readiness — Tenant tier passwordless login.
 *
 * Two-step flow per D.20 + `apps/api/src/modules/auth/tenant/otp.controller.ts`:
 *   1. Phone entry (+ optional org-slug if the resident owns
 *      apartments across multiple developers' orgs, per D.30/F2).
 *      POSTs `/api/v1/auth/otp/request` — always returns generic 200
 *      (anti-enumeration; we never reveal whether the phone matches
 *      a known owner).
 *   2. 6-digit code entry. POSTs `/api/v1/auth/otp/verify` which sets
 *      the `tenant_access_token` httpOnly cookie. Cookie is set by
 *      the BE through the same Pages-Function proxy used by the org
 *      and provider flows (D.35).
 *
 * BE invariants (otp.service.ts) the FE has to respect:
 *   - OTP TTL = 5 minutes (the SMS body literally says "תקף ל-5 דקות").
 *   - Rate limit = 3 SMS / 15 min / phone (silent throttle — same 200).
 *   - Rate limit (per-IP) = 5 requests / 15 min, 10 verifies / 15 min.
 *   - Code is exactly 6 digits, single-use, max 5 verify attempts.
 *   - Tenant access token TTL = 30 minutes.
 *
 * Form discipline (mirrors the org Login at A.S1):
 *   - `<form method="post" action="">` + `handleSubmit` — defense in
 *     depth so the SSR HTML never produces a GET-fallback credential
 *     leak (PR #47 + #61 + DoD-BROWSER-SMOKE.md).
 *   - `dir="ltr"` on phone + code inputs (LTR digit alignment).
 *   - `applyValidationErrors` maps `validation_error` to field errors;
 *     anything else collapses to a single generic message
 *     (`invalidOtp` / `otpRequestFailed`) — anti-enum.
 *
 * Hardening passes layered on top of A.S14a:
 *   - **Client-side phone validation** via `isValidIsraeliPhone` from
 *     `@emapp/validators` (the same normalizer the BE uses). Surfaces
 *     a clear "invalid phone" message INSTEAD of relying on the BE's
 *     silent no-op + a subsequent "invalid code" mismatch. The check
 *     is BEFORE the wire call — saves a round-trip and is anti-enum
 *     in the sense that we never disclose whether a valid phone maps
 *     to an owner.
 *   - **Resend code** with a 30-second cooldown (one attempt every
 *     half-minute is plenty; the BE silently caps at 3 SMS / 15 min
 *     per phone anyway). The cooldown avoids hammering the SMS
 *     provider during transient delivery delays.
 *   - **Auto-submit on 6 digits**: when the code input fills, fire
 *     `requestSubmit()`. Matches the muscle-memory of every iOS /
 *     Android auto-fill flow.
 *
 * After step-2 success: `router.push('/portal')` then `router.refresh()`
 * — the next middleware pass sees `tenant_access_token` and lets us
 * into the portal tier.
 *
 * Style: solo card on a centered page (no split-screen — the resident
 * surface is simpler than the org auth landing).
 */
const RESEND_COOLDOWN_SEC = 30;

export default function TenantLoginPage() {
  const t = useTranslations('auth.tenant');
  const tCommon = useTranslations('auth');
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  /** Surface generic anti-enum errors (network / unknown phone / wrong
   *  code) to the user without revealing which case occurred. */
  const [serverError, setServerError] = useState<string | null>(null);
  /** Positive ack after a resend so the user sees feedback even though
   *  the BE response is identical to the first request. */
  const [resendAck, setResendAck] = useState<string | null>(null);
  /** We hold the phone between the two steps so the verify form can
   *  include it (per OtpVerifyDto). Carried in component state, never
   *  in the URL — phone numbers are PII. We also store the optional
   *  org_slug from step 1 so the resend re-uses the same disambiguator. */
  const [phone, setPhone] = useState('');
  const [orgSlug, setOrgSlug] = useState<string | undefined>(undefined);
  /** Cooldown countdown for the resend button (seconds). */
  const [resendIn, setResendIn] = useState(0);
  /** Pending state for the resend button (independent of the verify form's
   *  isSubmitting which is owned by react-hook-form). */
  const [isResending, setIsResending] = useState(false);

  const phoneForm = useForm<OtpRequestDto>({ resolver: zodResolver(OtpRequestSchema) });
  const codeForm = useForm<OtpVerifyDto>({ resolver: zodResolver(OtpVerifySchema) });

  /** Ref on the wrapper form for the auto-submit-on-6-digits effect. */
  const codeFormRef = useRef<HTMLFormElement | null>(null);
  /** Watched value of the code input — used to trigger auto-submit when
   *  the user reaches 6 digits. RHF's `watch` is the canonical hook
   *  for cross-rendering an input value into an effect. */
  const codeValue = codeForm.watch('code');

  // Tick the resend cooldown once per second while it's positive.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = window.setInterval(() => {
      setResendIn((n) => (n > 0 ? n - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendIn]);

  // Auto-submit when the code input hits exactly 6 digits and the form
  // is not already submitting. Matches platform OTP auto-fill UX.
  useEffect(() => {
    if (step !== 'code') return;
    if (typeof codeValue !== 'string') return;
    if (!/^\d{6}$/.test(codeValue)) return;
    if (codeForm.formState.isSubmitting) return;
    // requestSubmit() triggers react-hook-form's onSubmit handler via
    // the form's `onSubmit` prop — same path as a click on the verify
    // button.
    codeFormRef.current?.requestSubmit();
  }, [codeValue, step, codeForm.formState.isSubmitting]);

  // Shared helper used by step-1 submit AND the resend button. Returns
  // true on a 200 (so callers can advance the step / show the ack);
  // false otherwise (caller leaves the UI as-is so the user can retry).
  const sendOtp = useCallback(
    async (phoneArg: string, orgSlugArg: string | undefined): Promise<boolean> => {
      const res = await apiClient.post<{ ok: true }>('/auth/otp/request', {
        phone: phoneArg,
        ...(orgSlugArg ? { org_slug: orgSlugArg } : {}),
      });
      if (isOk(res)) return true;
      const code = res.error.code;
      if (code === 'validation_error') {
        const applied = applyValidationErrors(res.error, (field, message) => {
          phoneForm.setError(field as keyof OtpRequestDto, { type: 'server', message });
        });
        if (applied.length === 0) setServerError(t('otpRequestFailed'));
      } else {
        setServerError(t('otpRequestFailed'));
      }
      return false;
    },
    [phoneForm, t],
  );

  async function onSubmitPhone(data: OtpRequestDto) {
    setServerError(null);
    setResendAck(null);

    // Client-side phone validation — same normalizer the BE uses
    // (`@emapp/validators`). Saves a wire round-trip and gives the user
    // an actionable message instead of the BE's silent no-op (anti-enum)
    // followed by a misleading "invalid code" on step 2.
    if (!isValidIsraeliPhone(data.phone)) {
      phoneForm.setError('phone', { type: 'client', message: t('phoneInvalid') });
      return;
    }

    const slug = data.org_slug?.trim() ? data.org_slug.trim() : undefined;
    const ok = await sendOtp(data.phone, slug);
    if (!ok) return;

    setPhone(data.phone);
    setOrgSlug(slug);
    // Seed the verify form so the user only types the code.
    codeForm.setValue('phone', data.phone);
    codeForm.setValue('code', '');
    setStep('code');
    setResendIn(RESEND_COOLDOWN_SEC);
  }

  async function onResend() {
    if (resendIn > 0 || isResending) return;
    setServerError(null);
    setResendAck(null);
    setIsResending(true);
    try {
      const ok = await sendOtp(phone, orgSlug);
      if (ok) {
        setResendAck(t('resendSent'));
        setResendIn(RESEND_COOLDOWN_SEC);
        codeForm.setValue('code', '');
      }
    } finally {
      setIsResending(false);
    }
  }

  async function onSubmitCode(data: OtpVerifyDto) {
    setServerError(null);
    setResendAck(null);
    const res = await apiClient.post<{ ok: true }>('/auth/otp/verify', data);
    if (isOk(res)) {
      // Cookie is now set by the BE response (`Set-Cookie: tenant_access_token`).
      // Push to /portal — middleware will let us through on the next request.
      router.push('/portal');
      router.refresh();
      return;
    }
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        codeForm.setError(field as keyof OtpVerifyDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('invalidOtp'));
    } else {
      setServerError(t('invalidOtp'));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ padding: 24 }}>
      <div className="card card-pad flex w-full flex-col gap-4" style={{ maxWidth: 420 }}>
        <header className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            {tCommon('rolePicker.tenant.label')}
          </span>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
            {step === 'phone' ? t('phoneStepTitle') : t('codeStepTitle')}
          </h1>
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {step === 'phone' ? t('phoneStepHint') : t('codeStepHint', { phone })}
          </p>
        </header>

        {step === 'phone' ? (
          <form
            method="post"
            action=""
            onSubmit={phoneForm.handleSubmit(onSubmitPhone)}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="t-phone" className="label">
                {t('phoneLabel')}
              </label>
              <input
                id="t-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                className="input tabular"
                placeholder={t('phonePlaceholder')}
                {...phoneForm.register('phone')}
              />
              {phoneForm.formState.errors.phone && (
                <span className="text-xs" style={{ color: 'var(--danger-700)' }}>
                  {phoneForm.formState.errors.phone.message}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="t-org-slug" className="label">
                {t('orgSlugLabel')}
              </label>
              <input
                id="t-org-slug"
                type="text"
                autoComplete="off"
                dir="ltr"
                className="input"
                placeholder={t('orgSlugPlaceholder')}
                {...phoneForm.register('org_slug')}
              />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {t('orgSlugHint')}
              </span>
              {phoneForm.formState.errors.org_slug && (
                <span className="text-xs" style={{ color: 'var(--danger-700)' }}>
                  {phoneForm.formState.errors.org_slug.message}
                </span>
              )}
            </div>

            {serverError && (
              <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
                {serverError}
              </p>
            )}

            <button
              type="submit"
              disabled={phoneForm.formState.isSubmitting}
              className="btn btn-primary"
            >
              {phoneForm.formState.isSubmitting ? t('sending') : t('sendCode')}
            </button>
          </form>
        ) : (
          <form
            ref={codeFormRef}
            method="post"
            action=""
            onSubmit={codeForm.handleSubmit(onSubmitCode)}
            className="flex flex-col gap-3"
          >
            {/* Hidden phone — included in the verify payload (OtpVerifyDto).
                The user already saw the phone in the title hint above; we
                don't re-render it as an input. */}
            <input type="hidden" {...codeForm.register('phone')} value={phone} />

            <div className="flex flex-col gap-1.5">
              <label htmlFor="t-code" className="label">
                {t('codeLabel')}
              </label>
              <input
                id="t-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                dir="ltr"
                maxLength={6}
                className="input tabular text-center"
                style={{ letterSpacing: '0.3em', fontSize: 18 }}
                placeholder="••••••"
                {...codeForm.register('code')}
              />
              {codeForm.formState.errors.code && (
                <span className="text-xs" style={{ color: 'var(--danger-700)' }}>
                  {codeForm.formState.errors.code.message}
                </span>
              )}
            </div>

            {resendAck && (
              <p className="text-sm" style={{ color: 'var(--success-700)' }} role="status">
                {resendAck}
              </p>
            )}

            {serverError && (
              <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
                {serverError}
              </p>
            )}

            <button
              type="submit"
              disabled={codeForm.formState.isSubmitting}
              className="btn btn-primary"
            >
              {codeForm.formState.isSubmitting ? t('verifying') : t('verify')}
            </button>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onResend}
                disabled={resendIn > 0 || isResending}
                className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
                aria-live="polite"
              >
                {isResending
                  ? t('resending')
                  : resendIn > 0
                    ? t('resendCooldown', { seconds: resendIn })
                    : t('resendCode')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setServerError(null);
                  setResendAck(null);
                  setResendIn(0);
                  codeForm.reset();
                  setStep('phone');
                }}
                className="btn btn-ghost btn-sm"
              >
                {t('changePhone')}
              </button>
            </div>
          </form>
        )}

        <div className="flex flex-col gap-1 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <Link
            href="/login"
            className="text-xs hover:underline"
            style={{ color: 'var(--navy-700)' }}
          >
            {t('notATenant')}
          </Link>
        </div>
      </div>
    </div>
  );
}
