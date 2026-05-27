'use client';

import {
  OtpRequestSchema,
  OtpVerifySchema,
  type OtpRequestDto,
  type OtpVerifyDto,
} from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

/**
 * V11 A.S14a — Tenant tier (resident) passwordless login.
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
 * Form discipline (mirrors the org Login at A.S1):
 *   - `<form method="post" action="">` + `handleSubmit` — defense in
 *     depth so the SSR HTML never produces a GET-fallback credential
 *     leak (PR #47 + #61 + DoD-BROWSER-SMOKE.md).
 *   - `dir="ltr"` on phone + code inputs (LTR digit alignment).
 *   - `applyValidationErrors` maps `validation_error` to field errors;
 *     anything else collapses to a single generic message
 *     (`invalidOtp` / `otpRequestFailed`) — anti-enum.
 *
 * After step-2 success: `router.push('/portal')` then `router.refresh()`
 * — the next middleware pass sees `tenant_access_token` and lets us
 * into the portal tier.
 *
 * Style: solo card on a centered page (no split-screen — the resident
 * surface is simpler than the org auth landing).
 */
export default function TenantLoginPage() {
  const t = useTranslations('auth.tenant');
  const tCommon = useTranslations('auth');
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  /** Surface generic anti-enum errors (network / unknown phone / wrong
   *  code) to the user without revealing which case occurred. */
  const [serverError, setServerError] = useState<string | null>(null);
  /** We hold the phone between the two steps so the verify form can
   *  include it (per OtpVerifyDto). Carried in component state, never
   *  in the URL — phone numbers are PII. */
  const [phone, setPhone] = useState('');

  const phoneForm = useForm<OtpRequestDto>({ resolver: zodResolver(OtpRequestSchema) });
  const codeForm = useForm<OtpVerifyDto>({ resolver: zodResolver(OtpVerifySchema) });

  async function onSubmitPhone(data: OtpRequestDto) {
    setServerError(null);
    const res = await apiClient.post<{ ok: true }>('/auth/otp/request', data);
    if (isOk(res)) {
      // 200 is generic — even for unknown phones. We optimistically
      // advance to the code-entry step regardless; the verify step
      // will surface a generic "invalid code" message if the phone
      // wasn't actually a known owner.
      setPhone(data.phone);
      // Seed the verify form so the user only types the code.
      codeForm.setValue('phone', data.phone);
      setStep('code');
      return;
    }
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        phoneForm.setError(field as keyof OtpRequestDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('otpRequestFailed'));
    } else {
      // Anti-enum collapse — throttle / network / etc. all surface
      // as the same generic copy.
      setServerError(t('otpRequestFailed'));
    }
  }

  async function onSubmitCode(data: OtpVerifyDto) {
    setServerError(null);
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

            <button
              type="button"
              onClick={() => {
                setServerError(null);
                setStep('phone');
              }}
              className="btn btn-secondary btn-sm"
            >
              {t('changePhone')}
            </button>
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
