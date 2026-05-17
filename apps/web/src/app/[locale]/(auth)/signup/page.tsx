'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { apiClient, isOk } from '@/lib/api-client';

const SignupSchema = z.object({
  org_name: z.string().min(2).max(120),
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(12).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/),
});
type SignupForm = z.infer<typeof SignupSchema>;

export default function SignupPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupForm>({ resolver: zodResolver(SignupSchema) });

  async function onSubmit(data: SignupForm) {
    setServerError(null);
    const res = await apiClient.post<{ user: object }>('/auth/signup', data);
    if (isOk(res)) {
      router.push('/');
      router.refresh();
    } else {
      const err = res.error;
      if (err.code === 'email_taken') {
        setServerError(t('emailTaken'));
      } else {
        setServerError(t('signupError'));
      }
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
            {errors.org_name && <p className="text-xs text-destructive">{t('required')}</p>}
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
            {errors.name && <p className="text-xs text-destructive">{t('required')}</p>}
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
            {errors.email && <p className="text-xs text-destructive">{t('emailInvalid')}</p>}
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
              <p className="text-xs text-destructive">{t('passwordRequirements')}</p>
            )}
          </div>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? t('signingUp') : t('createAccount')}
          </Button>
        </form>

        <p className="text-center text-sm">
          {t('hasAccount')}{' '}
          <a href="/login" className="font-medium underline">
            {t('login')}
          </a>
        </p>
      </div>
    </div>
  );
}
