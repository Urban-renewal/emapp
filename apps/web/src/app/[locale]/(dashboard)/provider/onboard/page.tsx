'use client';

import {
  OnboardOrgBodySchema,
  type OnboardOrgBody,
  type OnboardOrgResult,
} from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useOnboardOrg } from '@/hooks/use-provider';

/**
 * D.45 — Provider onboarding form: create an Org + invite its first
 * Manager. Mirrors the org-tier invite-member form (react-hook-form +
 * zodResolver + method="post" + invite-token-once display).
 *
 * Security posture:
 *  - This is a Provider WRITE — the call goes through the audit-first
 *    `withProvider` BE path; the session `access_reason` (AccessReasonGate
 *    wraps the whole /provider subtree) is attached by the API client.
 *  - `method="post"` + `onSubmit` preventDefault → the manager email /
 *    org name never leak to the URL (FE DoD, §S1-SEC1).
 *  - The one-shot `inviteToken` is shown ONCE in dev/test only (D.27);
 *    in prod the email is the sole channel and the token is absent. It is
 *    held in component state, never written to TanStack cache.
 */
export default function ProviderOnboardPage() {
  const t = useTranslations('provider.onboard');
  const router = useRouter();
  const mutation = useOnboardOrg();
  const [created, setCreated] = useState<OnboardOrgResult | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<OnboardOrgBody>({
    resolver: zodResolver(OnboardOrgBodySchema),
  });

  const { serverError, handle, reset } = useApiErrorHandler<OnboardOrgBody>({
    setError,
    fallback: () => t('failed'),
  });

  async function onSubmit(values: OnboardOrgBody) {
    reset();
    try {
      const result = await mutation.mutateAsync(values);
      setCreated(result);
    } catch (e) {
      handle(e);
    }
  }

  async function copyToken() {
    if (!created?.inviteToken) return;
    try {
      await navigator.clipboard.writeText(created.inviteToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in non-secure contexts; the operator can
      // still select-and-copy from the visible textarea.
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-xl space-y-6" dir="rtl">
        <h1 className="text-2xl font-bold">{t('createdTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('createdHint')}</p>

        <div className="rounded-md border border-border bg-status-success-bg p-4 text-status-success-fg">
          <p className="text-sm font-medium">{t('createdOrg')}:</p>
          <p className="mt-1 text-sm">
            {created.orgName} · <span dir="ltr">{created.slug}</span>
          </p>
          <p className="mt-1 text-sm">
            {t('inviteSentTo')} <span dir="ltr">{created.managerEmail}</span>
          </p>
        </div>

        {created.inviteToken ? (
          <div className="space-y-2">
            <label htmlFor="invite-token" className="block text-sm font-medium">
              {t('inviteTokenLabel')}
            </label>
            <textarea
              id="invite-token"
              readOnly
              value={created.inviteToken}
              rows={4}
              dir="ltr"
              className="w-full rounded-md border bg-muted px-3 py-2 font-mono text-xs"
            />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copyToken}>
                {copied ? t('copied') : t('copy')}
              </Button>
              <p className="text-xs text-status-warning-fg">{t('inviteTokenWarning')}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('inviteTokenEmailOnly')}</p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push('/provider/tenants')}>
            {t('backToList')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      {/* §S1-SEC1 — method="post" defense in depth (no GET-fallback leak). */}
      <form method="post" action="" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="orgName" className="text-sm font-medium">
            {t('field.orgName')}
          </label>
          <input
            id="orgName"
            type="text"
            autoComplete="off"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('orgName')}
          />
          {errors.orgName && <p className="text-xs text-destructive">{errors.orgName.message}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="managerName" className="text-sm font-medium">
            {t('field.managerName')}
          </label>
          <input
            id="managerName"
            type="text"
            autoComplete="off"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('managerName')}
          />
          {errors.managerName && (
            <p className="text-xs text-destructive">{errors.managerName.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="managerEmail" className="text-sm font-medium">
            {t('field.managerEmail')}
          </label>
          <input
            id="managerEmail"
            type="email"
            autoComplete="off"
            dir="ltr"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('managerEmail')}
          />
          {errors.managerEmail && (
            <p className="text-xs text-destructive">{errors.managerEmail.message}</p>
          )}
        </div>

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push('/provider/tenants')}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('submitting') : t('submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
