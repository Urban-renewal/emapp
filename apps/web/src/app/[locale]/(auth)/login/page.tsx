'use client';

import { LoginSchema, type LoginDto } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

/**
 * Org login — email + password for ANY org user (manager / agent / viewer).
 * The login payload carries NO role; the BE derives the role from the account,
 * so one form serves all org staff and each lands on a dashboard scoped to
 * their own permissions. The other tiers have their own entries:
 *   - Provider  → /provider/login (MFA mandatory, D.55)
 *   - Resident  → /tenant/login   (SMS OTP, D.20)
 *   - Contractor → a manager-issued share-link (no self-login, D.45/D.46)
 *
 * The V11-reskin role-picker was removed: it was cosmetic (never sent a role)
 * and listed the external tiers as if they logged in here, which misrepresented
 * the auth model and blocked agent/viewer in the UI.
 *
 * Auth flow: `method="post"` + `action=""` (defense in depth per PR #47/#61),
 * `handleSubmit` (preventDefault on hydrated path), `apiClient.post` (D.35
 * same-origin proxy), `applyValidationErrors`, anti-enum generic message.
 */

/**
 * Public self-service signup gate (off by default). `NEXT_PUBLIC_SIGNUP_ENABLED`
 * is inlined at build time; anything other than '1' hides the signup entry
 * point. Mirrors the server-side `PUBLIC_SIGNUP_ENABLED` flag.
 */
const SIGNUP_ENABLED = process.env['NEXT_PUBLIC_SIGNUP_ENABLED'] === '1';

export default function LoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginDto>({ resolver: zodResolver(LoginSchema) });

  async function onSubmit(data: LoginDto) {
    setServerError(null);
    const res = await apiClient.post<{ user: object }>('/auth/login', data);
    if (isOk(res)) {
      router.push('/');
      router.refresh();
      return;
    }
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        setError(field as keyof LoginDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('invalidCredentials'));
    } else {
      setServerError(t('invalidCredentials'));
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Brand panel — first in HTML order, renders on the right under
       *  RTL flex (matches handoff screenshot 01-login.png). */}
      <div
        className="relative flex flex-1 flex-col justify-between overflow-hidden p-12 text-white"
        style={{ background: 'linear-gradient(160deg, var(--navy-900) 0%, var(--navy-700) 100%)' }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 80% 20%, rgba(255,255,255,.06), transparent 50%), radial-gradient(circle at 20% 80%, rgba(255,255,255,.04), transparent 50%)',
          }}
        />
        <div className="relative z-10 flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-[10px] text-sm font-bold tracking-wider"
            style={{ background: 'rgba(255,255,255,.12)' }}
          >
            EM
          </div>
          <div className="text-xl font-semibold">EMAPP</div>
        </div>
        <div className="relative z-10 max-w-[460px]">
          <h1 className="mb-4 text-[38px] font-bold leading-[1.15]">{t('brandHeadline')}</h1>
          <p className="text-[15px] leading-[1.6]" style={{ color: 'rgba(255,255,255,.75)' }}>
            {t('brandSubtitle')}
          </p>
        </div>
        <div className="relative z-10 text-xs" style={{ color: 'rgba(255,255,255,.5)' }}>
          {t('brandCopyright')}
        </div>
      </div>

      {/* Form panel — 480px wide, renders on the left under RTL flex. */}
      <div className="flex w-[480px] flex-col justify-center px-14 py-16">
        <div className="mb-7">
          <div className="mb-1.5 text-2xl font-bold">{t('formHeading')}</div>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('formSubheading')}
          </div>
        </div>

        <form
          method="post"
          action=""
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <div>
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
              <p className="mt-1 text-xs" style={{ color: 'var(--danger-700)' }}>
                {errors.email.message ?? t('emailInvalid')}
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="password">
              {t('password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="input"
              dir="ltr"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs" style={{ color: 'var(--danger-700)' }}>
                {errors.password.message ?? t('required')}
              </p>
            )}
          </div>

          {serverError && (
            <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
              {serverError}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-primary btn-lg w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? t('loggingIn') : t('loginCta')}
          </button>
        </form>

        {/* Public self-service signup is INACTIVE by default (owner-approved,
         *  refines D.21 — the active onboarding path is provider-led). The
         *  signup entry point is gated behind NEXT_PUBLIC_SIGNUP_ENABLED (off
         *  by default; inlined at build time). Set it to '1' to restore the
         *  link. The /signup page itself redirects to /login while disabled.
         *  See docs/decision-records/disable-public-signup.md. */}
        {SIGNUP_ENABLED && (
          <p className="mt-5 text-center text-sm">
            {t('noAccount')}{' '}
            <Link
              href="/signup"
              className="font-medium underline"
              style={{ color: 'var(--navy-700)' }}
            >
              {t('signup')}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
