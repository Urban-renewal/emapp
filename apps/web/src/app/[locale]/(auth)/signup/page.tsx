'use client';

import { SignupSchema, type SignupDto } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

export default function SignupPage() {
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
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        setError(field as keyof SignupDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('signupError'));
    } else if (code === 'email_taken') {
      setServerError(t('emailTaken'));
    } else {
      setServerError(t('signupError'));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">{t('signupTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('signupSubtitle')}</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" dir="rtl">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="org_name">
              {t('orgName')}
            </label>
            <input
              id="org_name"
              type="text"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('org_name')}
            />
            {errors.org_name && (
              <p className="text-xs text-destructive">{errors.org_name.message ?? t('required')}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="name">
              {t('fullName')}
            </label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('name')}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message ?? t('required')}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="email">
              {t('email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('email')}
            />
            {errors.email && (
              <p className="text-xs text-destructive">
                {errors.email.message ?? t('emailInvalid')}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="password">
              {t('password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs text-destructive">
                {errors.password.message ?? t('passwordRequirements')}
              </p>
            )}
          </div>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? t('signingUp') : t('createAccount')}
          </Button>
        </form>

        <p className="text-center text-sm">
          {t('hasAccount')}{' '}
          <Link href="/login" className="font-medium underline">
            {t('login')}
          </Link>
        </p>
      </div>
    </div>
  );
}
