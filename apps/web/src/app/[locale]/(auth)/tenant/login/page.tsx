'use client';

import { type OtpRequestDto, type OtpVerifyDto } from '@emapp/shared-types';
import { isValidIsraeliPhone } from '@emapp/validators';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

/**
 * V11 A.S14a + external-services-readiness — Tenant tier passwordless login.
 *
 * Two-step flow per D.20 + `apps/api/src/modules/auth/tenant/otp.controller.ts`:
 *   1. Phone entry (+ optional org-slug if the resident owns
 *      apartments across multiple developers' orgs, per D.30/F2).
 *      A `?org=<slug>` query param (P4 #7) pre-fills the org-slug field
 *      so a multi-org resident arriving via a slug-carrying login link
 *      lands on a ready-to-submit form. The slug is a public org id
 *      (zero PII) — a convenience pre-fill only; the BE re-authorizes by
 *      phone + slug + OTP, so a wrong/forged slug just yields the same
 *      generic no-op. A single-org resident (no `?org=`) is unaffected.
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

/**
 * P4 #7 — multi-org resident deep-link. The tenant-login URL a resident
 * receives can carry `?org=<slug>` so a resident who owns apartments
 * across ≥2 developer orgs lands on a form whose org-slug field is
 * already filled (the BE's F2 path needs the slug to disambiguate; the
 * resident never knows it). The slug is a PUBLIC org identifier
 * (`organizations.slug`, zero PII) — it is a convenience pre-fill ONLY.
 * The BE remains the sole authority (phone + slug + OTP); a wrong/forged
 * slug just yields the same generic anti-enum no-op.
 *
 * Sanitize defensively: a slug is `[a-z0-9-]` (matches the org-creation
 * slugifier). Lower-case, strip anything else, and cap at the schema max
 * (100, `OtpRequestSchema.org_slug`). An empty result → no pre-fill (the
 * single-org resident is unaffected; the field stays optional/empty).
 */
const SLUG_MAX_LEN = 100;
export function sanitizeOrgSlug(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, SLUG_MAX_LEN);
}

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

  // No Zod resolver here — we validate manually in onSubmitPhone /
  // onSubmitCode so that:
  //   - The empty optional `org_slug` field doesn't trip Zod's
  //     `min(1)` rejection (manual-audit bug #2).
  //   - The phone field surfaces our Hebrew `phoneInvalid` copy
  //     instead of Zod's English default "String must contain at
  //     least 9 character(s)" (manual-audit bug #1).
  // The BE schema (OtpRequestSchema / OtpVerifySchema in
  // @emapp/shared-types) remains the authoritative wire validator —
  // FE just produces the correct payload shape.
  const phoneForm = useForm<OtpRequestDto>();
  const codeForm = useForm<OtpVerifyDto>();

  // P4 #7 — multi-org deep-link. Read `?org=<slug>` off the URL and
  // pre-fill the (already-existing, optional) org-slug field so a
  // multi-org resident's form is ready to submit. `useMemo` keeps the
  // derived value stable across re-renders (same pattern as the provider
  // audit deep-link). The slug is sanitized (public id, never trusted for
  // anything security-sensitive — the BE re-authorizes).
  const searchParams = useSearchParams();
  const deepLinkSlug = useMemo(() => sanitizeOrgSlug(searchParams?.get('org')), [searchParams]);
  /** True once the deep-link slug has been written into the form field —
   *  drives the small "filled for you from your link" hint. We render the
   *  hint off the live field value so it disappears if the user clears the
   *  field, and we only show it for a non-empty deep-link slug. */
  const orgSlugFieldValue = phoneForm.watch('org_slug');
  const showPrefilledHint = deepLinkSlug.length > 0 && orgSlugFieldValue === deepLinkSlug;

  /** Ref on the wrapper form for the auto-submit-on-6-digits effect. */
  const codeFormRef = useRef<HTMLFormElement | null>(null);
  /** Tracks the last 6-digit code value that the auto-submit effect
   *  fired for. The effect compares the current `codeValue` against
   *  this and skips if they match — guaranteeing EXACTLY ONE
   *  auto-submit per unique code (manual-audit bug #3 fix). Reset to
   *  null on step transitions, resend, and change-phone so a fresh
   *  code entry can re-arm. RHF's `formState.isSubmitting` lags by
   *  a render or two and was insufficient on its own — the effect
   *  re-ran 5x in the same render-cycle window before isSubmitting
   *  flipped, burning the BE's 5-attempt-per-OTP cap on one keystroke. */
  const lastSubmittedCodeRef = useRef<string | null>(null);
  /** Watched value of the code input — used to trigger auto-submit when
   *  the user reaches 6 digits. RHF's `watch` is the canonical hook
   *  for cross-rendering an input value into an effect. */
  const codeValue = codeForm.watch('code');

  // P4 #7 — pre-fill the org-slug field from the `?org=<slug>` deep-link
  // exactly once on mount (when present). `setValue` (not `defaultValues`)
  // because the slug is derived asynchronously from `useSearchParams`,
  // which is null on the very first render. We deliberately do NOT keep
  // re-applying it on every render — once set, the field is the user's to
  // edit (they can correct or clear it). The empty-slug case is a no-op,
  // so a single-org resident is entirely unaffected.
  useEffect(() => {
    if (deepLinkSlug.length === 0) return;
    phoneForm.setValue('org_slug', deepLinkSlug);
    // Intentionally mount-once on the derived slug; phoneForm is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkSlug]);

  // Tick the resend cooldown once per second while it's positive.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = window.setInterval(() => {
      setResendIn((n) => (n > 0 ? n - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendIn]);

  // Auto-submit when the code input hits exactly 6 digits AND this
  // exact code value hasn't already been auto-submitted. The
  // value-comparison guard (vs the previous boolean flag) means each
  // distinct 6-digit value gets exactly one auto-fire — and editing
  // the code (state value changes) is the only path to re-arming.
  useEffect(() => {
    if (step !== 'code') return;
    if (typeof codeValue !== 'string') return;
    if (!/^\d{6}$/.test(codeValue)) return;
    if (lastSubmittedCodeRef.current === codeValue) return;
    if (codeForm.formState.isSubmitting) return;
    lastSubmittedCodeRef.current = codeValue;
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

    // Manual validation (no Zod resolver — see useForm comment above).
    // Phone is the only required field; we use the SAME normalizer the
    // BE uses (`@emapp/validators`) so the FE check matches the BE
    // behavior exactly. Empty / too-short / wrong-prefix all collapse
    // into the same Hebrew `phoneInvalid` copy — anti-enum is preserved
    // because we never disclose whether a valid phone maps to an owner.
    const phoneRaw = typeof data.phone === 'string' ? data.phone.trim() : '';
    // TODO C14-P1.2 — the OTP-schema `isValidIsraeliPhone` tightening is a
    // separate deferred slice; this slice is FE re-skin only (no auth/OTP
    // logic or schema change here).
    if (!isValidIsraeliPhone(phoneRaw)) {
      phoneForm.setError('phone', { type: 'client', message: t('phoneInvalid') });
      return;
    }

    // org_slug is optional. RHF passes "" for an empty input; we
    // normalize to undefined so the wire payload omits the field
    // (BE's F2 disambiguator only activates when present).
    const slug =
      typeof data.org_slug === 'string' && data.org_slug.trim() ? data.org_slug.trim() : undefined;

    const ok = await sendOtp(phoneRaw, slug);
    if (!ok) return;

    setPhone(phoneRaw);
    setOrgSlug(slug);
    // Seed the verify form so the user only types the code, and clear
    // any previous code value + reset the auto-submit guard so a fresh
    // step-2 entry can fire normally.
    codeForm.setValue('phone', phoneRaw);
    codeForm.setValue('code', '');
    lastSubmittedCodeRef.current = null;
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
        // Re-arm the auto-submit guard for the next 6-digit input.
        lastSubmittedCodeRef.current = null;
      }
    } finally {
      setIsResending(false);
    }
  }

  async function onSubmitCode(data: OtpVerifyDto) {
    setServerError(null);
    setResendAck(null);
    // Manual code validation — strict 6 digits. The auto-submit
    // effect already gates on /^\d{6}$/, but the verify button can
    // also fire with a partial entry; reject those before the wire
    // call so we don't burn an attempt for a malformed code.
    const codeRaw = typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^\d{6}$/.test(codeRaw)) {
      codeForm.setError('code', { type: 'client', message: t('invalidOtp') });
      return;
    }

    try {
      const res = await apiClient.post<{ ok: true }>('/auth/otp/verify', {
        phone: data.phone,
        code: codeRaw,
      });
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
    } catch {
      setServerError(t('invalidOtp'));
    }
    // Note: we deliberately do NOT reset `lastSubmittedCodeRef` here.
    // The ref tracks "which 6-digit value has already been tried"; a
    // failed verify must NOT auto-retry the same value (BE locks
    // after 5 wrong attempts). The user must edit the code to re-arm,
    // which changes codeValue → ref-comparison fails → new fire.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-app p-6">
      <div className="card card-pad flex w-full flex-col gap-4" style={{ maxWidth: 420 }}>
        <header className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-muted">
            {tCommon('rolePicker.tenant.label')}
          </span>
          <h1 className="text-xl font-bold text-text">
            {step === 'phone' ? t('phoneStepTitle') : t('codeStepTitle')}
          </h1>
          <p className="text-[13px] text-text-muted">
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
                <span className="text-xs text-danger-700">
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
              <span className="text-[11px] text-text-muted">{t('orgSlugHint')}</span>
              {showPrefilledHint && (
                <span className="text-[11px] text-success-700" role="status">
                  {t('orgSlugPrefilled')}
                </span>
              )}
              {phoneForm.formState.errors.org_slug && (
                <span className="text-xs text-danger-700">
                  {phoneForm.formState.errors.org_slug.message}
                </span>
              )}
            </div>

            {serverError && (
              <p className="text-sm text-danger-700" role="alert">
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
                <span className="text-xs text-danger-700">
                  {codeForm.formState.errors.code.message}
                </span>
              )}
            </div>

            {resendAck && (
              <p className="text-sm text-success-700" role="status">
                {resendAck}
              </p>
            )}

            {serverError && (
              <p className="text-sm text-danger-700" role="alert">
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
                  lastSubmittedCodeRef.current = null;
                  setStep('phone');
                }}
                className="btn btn-ghost btn-sm"
              >
                {t('changePhone')}
              </button>
            </div>
          </form>
        )}

        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <Link href="/login" className="text-xs text-navy-700 hover:underline">
            {t('notATenant')}
          </Link>
        </div>
      </div>
    </div>
  );
}
