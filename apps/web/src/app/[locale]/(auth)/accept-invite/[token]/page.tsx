'use client';

import { AcceptInviteInput, type AcceptInvite } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { use, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ApiClientError } from '@/lib/api/errors';
import { acceptInvite } from '@/lib/api/members';

interface PageProps {
  params: Promise<{ token: string }>;
}

/** Form schema = AcceptInviteInput + a client-only `confirmPassword`
 *  match assertion. The wire ONLY carries `password` — the
 *  `confirmPassword` field never reaches the network. */
const AcceptInviteFormSchema = AcceptInviteInput.omit({ token: true })
  .extend({ confirmPassword: z.string() })
  .refine((d) => d.password === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'PASSWORDS_DO_NOT_MATCH',
  });

type AcceptInviteForm = z.infer<typeof AcceptInviteFormSchema>;

/**
 * Public accept-invite landing page.
 *
 *  - Token is in the URL PATH (D.33-style — short, opaque, no query
 *    string leakage to Referer). The middleware whitelists this route
 *    as locale-aware public (see middleware.ts PUBLIC_ROUTE_REGEX).
 *  - Anti-enumeration: every BE failure (expired / bad-shape / wrong-
 *    sub / membership-not-found) returns generic `invalid_invite`. We
 *    surface a single Hebrew/English message ("הקישור אינו תקף") so a
 *    probing visitor cannot distinguish causes.
 *  - The invitee picks their OWN password — the Manager never learns
 *    it (ISO A.9.2.1/A.9.4.3). Min 12 chars (server-enforced via
 *    AcceptInviteInput Zod refinement).
 *  - method="post" defense in depth — pre-hydration submit would
 *    otherwise put the chosen password in the URL.
 *  - Success → /<locale>/login. The user logs in normally (cookies
 *    set; no auto-login from accept-invite to avoid token reuse and
 *    keep the audit chain clean).
 */
export default function AcceptInvitePage({ params }: PageProps) {
  const { token } = use(params);
  const t = useTranslations('acceptInvite');
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AcceptInviteForm>({
    resolver: zodResolver(AcceptInviteFormSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  async function onSubmit(values: AcceptInviteForm) {
    setServerError(null);
    const body: AcceptInvite = { token, password: values.password };
    try {
      await acceptInvite(body);
      setDone(true);
      // Short delay so the success UI is visible, then route to login.
      setTimeout(() => router.push('/login'), 1200);
    } catch (e) {
      // Anti-enumeration — every BE failure (incl. validation_error
      // on a too-short password that slipped past client Zod) collapses
      // to the same generic message. The form is the only audience.
      if (e instanceof ApiClientError && e.code === 'validation_error') {
        setServerError(t('passwordRequirements'));
      } else {
        setServerError(t('invalidInvite'));
      }
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-app p-4">
        <div className="card card-pad w-full max-w-sm space-y-4 text-center">
          <h1 className="text-2xl font-bold text-text">{t('doneTitle')}</h1>
          <p className="text-sm text-muted">{t('doneBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-app p-4">
      <div className="card card-pad w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-text">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>
        </div>

        {/* §S1-SEC1 — method="post" defense in depth (login/signup pattern). */}
        <form
          method="post"
          action=""
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
          dir="rtl"
        >
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

          <div className="space-y-1">
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
              <p className="mt-1 text-xs text-danger-700">{t('passwordsMismatch')}</p>
            )}
          </div>

          {serverError && <p className="text-sm text-danger-700">{serverError}</p>}

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
