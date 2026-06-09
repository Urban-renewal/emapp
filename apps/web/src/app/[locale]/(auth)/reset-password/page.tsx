'use client';

import { ResetPasswordSchema } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { resetPassword } from '@/lib/api/auth';
import { ApiClientError } from '@/lib/api/errors';

/**
 * Reset-password (P1 R0.1, OWASP Forgot-Password).
 *
 * Reads the raw one-time token from `?token=` (the emailed link). The user
 * sets a new password (min 12, same policy as signup, re-validated server-
 * side); on success the BE purges all the user's sessions and we redirect to
 * /login.
 *
 * Security posture (mirrors accept-invite):
 *  - `confirmPassword` is a CLIENT-ONLY match assertion — the wire carries
 *    ONLY `{ token, newPassword }`.
 *  - Anti-enumeration: every BE failure (not-found / expired / used /
 *    validation) collapses to ONE generic message — a probing visitor cannot
 *    distinguish causes.
 *  - `method="post"` defense in depth — a pre-hydration submit would otherwise
 *    put the new password (and token) in the URL. Enforced by the DoD static
 *    check.
 */

// Form schema = the wire's `newPassword` policy + a client-only confirm match.
// The token comes from the URL, not the form, so it's omitted here.
const ResetPasswordFormSchema = ResetPasswordSchema.pick({ newPassword: true })
  .extend({ confirmPassword: z.string() })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'PASSWORDS_DO_NOT_MATCH',
  });

type ResetPasswordForm = z.infer<typeof ResetPasswordFormSchema>;

function ResetPasswordInner() {
  const t = useTranslations('resetPassword');
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordForm>({
    resolver: zodResolver(ResetPasswordFormSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  async function onSubmit(values: ResetPasswordForm) {
    setServerError(null);
    try {
      await resetPassword({ token, newPassword: values.newPassword });
      setDone(true);
      // Short delay so the success UI is visible, then route to login.
      setTimeout(() => router.push('/login'), 1200);
    } catch (e) {
      // Anti-enumeration — every BE failure collapses to the same generic
      // message (no oracle on token validity).
      if (e instanceof ApiClientError && e.code === 'validation_error') {
        setServerError(t('passwordRequirements'));
      } else {
        setServerError(t('invalidToken'));
      }
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-2xl font-bold">{t('doneTitle')}</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('doneBody')}
          </p>
        </div>
      </div>
    );
  }

  // No token in the URL → the link is malformed. Offer a fresh request rather
  // than a dead form.
  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4" dir="rtl">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
            {t('missingToken')}
          </p>
          <Link
            href="/forgot-password"
            className="font-medium underline"
            style={{ color: 'var(--navy-700)' }}
          >
            {t('requestNewLink')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('subtitle')}
          </p>
        </div>

        <form
          method="post"
          action=""
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <div>
            <label className="label" htmlFor="newPassword">
              {t('password')}
            </label>
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              className="input"
              dir="ltr"
              {...register('newPassword')}
            />
            {errors.newPassword && (
              <p className="mt-1 text-xs" style={{ color: 'var(--danger-700)' }}>
                {errors.newPassword.message ?? t('passwordRequirements')}
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="confirmPassword">
              {t('confirmPassword')}
            </label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              className="input"
              dir="ltr"
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p className="mt-1 text-xs" style={{ color: 'var(--danger-700)' }}>
                {t('passwordsMismatch')}
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
            {isSubmitting ? t('submitting') : t('submit')}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary in the App Router (the page
 * would otherwise opt the whole route into client-side rendering with a build
 * warning). The boundary renders nothing until the params resolve.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
