'use client';

import { SignupSchema, type SignupDto } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { redirect, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

/**
 * Public self-service signup gate (off by default). `NEXT_PUBLIC_SIGNUP_ENABLED`
 * is inlined at build time; anything other than '1' disables the page. Mirrors
 * the server-side `PUBLIC_SIGNUP_ENABLED` flag (POST /auth/signup → 404).
 */
const SIGNUP_ENABLED = process.env['NEXT_PUBLIC_SIGNUP_ENABLED'] === '1';

export default function SignupPage() {
  // Public self-service signup is INACTIVE by default (owner-approved, refines
  // D.21 — the active onboarding path is provider-led). When disabled, this
  // page bounces to /login. The page + form code are RETAINED intact for future
  // reuse. See docs/decision-records/disable-public-signup.md.
  if (!SIGNUP_ENABLED) {
    redirect('/login');
  }

  const t = useTranslations('auth');
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupDto>({ resolver: zodResolver(SignupSchema) });

  async function onSubmit(data: SignupDto) {
    setServerError(null);
    // D.14 anti-enumeration: the server returns the SAME 201 envelope on
    // duplicate-email signups (no `email_taken` is ever emitted today). The
    // `email_taken` branch below stays as defense-in-depth in case the
    // contract drifts; today's signup-with-duplicate-email leads to a
    // success envelope without cookies, the next render bounces to /login.
    const res = await apiClient.post<{ user: object }>('/auth/signup', data);
    if (isOk(res)) {
      router.push('/');
      router.refresh();
      return;
    }
    // §SEC-M3 — D.14 anti-enumeration contract: the server returns
    // the SAME 201 envelope on duplicate-email signups (no `email_taken`
    // is ever emitted). The previous defensive `else if (code ===
    // 'email_taken')` branch (with `t('emailTaken')` Hebrew string)
    // was a contract leak: it shipped a string that hinted at the
    // hidden contract and created a trivial regression vector. We
    // collapse every non-validation error to the generic message —
    // defense in depth IS the BE invariant + spec, not FE retention.
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        setError(field as keyof SignupDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('signupError'));
    } else {
      setServerError(t('signupError'));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-app p-4">
      <div className="card card-pad w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-text">{t('signupTitle')}</h1>
          <p className="mt-1 text-sm text-muted">{t('signupSubtitle')}</p>
        </div>

        {/* §S1-SEC1 — see login/page.tsx for rationale: method="post"
            is defense in depth against the GET-fallback URL credential
            leak (JS-disabled, pre-hydration, hydration failure). */}
        <form
          method="post"
          action=""
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
          dir="rtl"
        >
          <div className="space-y-1">
            <label className="label" htmlFor="org_name">
              {t('orgName')}
            </label>
            <input id="org_name" type="text" className="input" {...register('org_name')} />
            {errors.org_name && (
              <p className="mt-1 text-xs text-danger-700">
                {errors.org_name.message ?? t('required')}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="label" htmlFor="name">
              {t('fullName')}
            </label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              className="input"
              {...register('name')}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-danger-700">{errors.name.message ?? t('required')}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="label" htmlFor="email">
              {t('email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="input"
              dir="ltr"
              {...register('email')}
            />
            {errors.email && (
              <p className="mt-1 text-xs text-danger-700">
                {errors.email.message ?? t('emailInvalid')}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="label" htmlFor="password">
              {t('password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className="input"
              dir="ltr"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-danger-700">
                {errors.password.message ?? t('passwordRequirements')}
              </p>
            )}
          </div>

          {serverError && <p className="text-sm text-danger-700">{serverError}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-primary btn-lg w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? t('signingUp') : t('createAccount')}
          </button>
        </form>

        <p className="text-center text-sm">
          {t('hasAccount')}{' '}
          <Link href="/login" className="font-medium text-navy-700 underline">
            {t('login')}
          </Link>
        </p>
      </div>
    </div>
  );
}
