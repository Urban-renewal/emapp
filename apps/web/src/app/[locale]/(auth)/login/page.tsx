'use client';

import { LoginSchema, type LoginDto } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

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
    // D.16 — switch on error.code, never on message.
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        setError(field as keyof LoginDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('invalidCredentials'));
    } else {
      // invalid_credentials / locked / etc. — anti-enumeration: same message.
      setServerError(t('invalidCredentials'));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">{t('loginTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('loginSubtitle')}</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" dir="rtl">
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
              autoComplete="current-password"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs text-destructive">{errors.password.message ?? t('required')}</p>
            )}
          </div>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? t('loggingIn') : t('login')}
          </Button>
        </form>

        <p className="text-center text-sm">
          {t('noAccount')}{' '}
          <Link href="/signup" className="font-medium underline">
            {t('signup')}
          </Link>
        </p>
      </div>
    </div>
  );
}
