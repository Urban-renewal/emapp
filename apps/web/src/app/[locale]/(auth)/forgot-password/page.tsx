'use client';

import { ForgotPasswordSchema, type ForgotPasswordDto } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { forgotPassword } from '@/lib/api/auth';

/**
 * Forgot-password (P1 R0.1, OWASP Forgot-Password).
 *
 * Email-only form. The BE ALWAYS answers a generic 200 (anti-enumeration —
 * never reveals whether the email exists), so on ANY non-transport outcome we
 * show the SAME neutral "if the email exists, we sent a link" notice. We never
 * branch the UI on account existence.
 *
 * Security posture (mirrors login):
 *  - `method="post"` + `action=""` defense in depth: a pre-hydration submit
 *    would otherwise put the email in the URL (GET-fallback leak). The DoD
 *    static check (`app-forms-no-get-fallback.spec.ts`) enforces this.
 *  - `handleSubmit` preventDefault on the hydrated path; `apiClient.post`
 *    (D.35 same-origin proxy). No console.log.
 */
export default function ForgotPasswordPage() {
  const t = useTranslations('forgotPassword');
  const [sent, setSent] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordDto>({ resolver: zodResolver(ForgotPasswordSchema) });

  async function onSubmit(data: ForgotPasswordDto) {
    setServerError(null);
    try {
      await forgotPassword(data);
      // ALWAYS the generic notice — no existence oracle.
      setSent(true);
    } catch {
      // Only transport/5xx reaches here (the BE 200s on the happy + unknown
      // paths). Generic retry message — still no oracle.
      setServerError(t('error'));
    }
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

        {sent ? (
          <p className="text-center text-sm" role="status">
            {t('genericNotice')}
          </p>
        ) : (
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
        )}

        <p className="text-center text-sm">
          <Link
            href="/login"
            className="font-medium underline"
            style={{ color: 'var(--navy-700)' }}
          >
            {t('backToLogin')}
          </Link>
        </p>
      </div>
    </div>
  );
}
