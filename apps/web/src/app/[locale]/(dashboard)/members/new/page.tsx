'use client';

import { CreateMemberInput, OrgRoleEnum, type CreateMember } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useCreateMember } from '@/hooks/use-members';
import type { CreateMemberResult } from '@/lib/api/members';

/**
 * Invite-member form (Manager-only resource).
 *
 * Flow:
 *  1. Manager fills email + name + role → submit.
 *  2. BE atomically creates user(pending) + membership(pending) and
 *     emits an `inviteToken`. In NON-PROD environments the token also
 *     returns in the response (`CreateMemberResult.inviteToken`); in
 *     prod the email is the only delivery (D.27 — token suppressed).
 *  3. On success — if a token was returned — show it ONCE with copy
 *     + warning. Then back-to-list. The token is held in component
 *     state, never written to TanStack cache, never re-displayed on
 *     subsequent reads.
 *
 * Defense-in-depth:
 *  - method="post" + onSubmit preventDefault (login-page-style;
 *    closes §S1-SEC1 — no GET-fallback URL credential leak).
 *  - Idempotency-Key auto-mint via apiClient.postIdempotent (so a
 *    double-clicked Submit invites ONCE, not twice — §v9-P0-3).
 *  - `member_exists` 409 maps to a field error on `email`.
 */
export default function NewMemberPage() {
  const t = useTranslations('members');
  // Reuse the existing nav.role namespace (used by topbar) so role
  // labels are owned in ONE place — and the topbar+members views can
  // never display divergent labels for the same enum value.
  const trl = useTranslations('nav.role');
  const tp = useTranslations('projects');
  const router = useRouter();
  const mutation = useCreateMember();
  const [created, setCreated] = useState<CreateMemberResult | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateMember>({
    resolver: zodResolver(CreateMemberInput),
    defaultValues: { role: 'agent' },
  });

  // §D.14 anti-enumeration — a duplicate-email invite (BE `member_exists`,
  // 409) must NOT reveal "this exact email already exists" on the email field:
  // that is an account-enumeration oracle. Fall through to the GENERIC
  // top-level error (same message for duplicate / RBAC / network).
  const { serverError, handle, reset } = useApiErrorHandler<CreateMember>({
    setError,
    fallback: () => t('inviteGenericError'),
  });

  async function onSubmit(values: CreateMember) {
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
      // Clipboard API can fail in non-secure contexts or under
      // permission denial — silently swallow; the Manager can still
      // select-and-copy manually from the visible textarea.
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-xl space-y-6" dir="rtl">
        <h1 className="text-2xl font-bold">{t('createdTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('createdHint')}</p>

        <div className="rounded-md border bg-status-success-bg p-4 text-status-success-fg">
          <p className="text-sm font-medium">{t('createdMember')}:</p>
          <p className="mt-1 text-sm">
            {created.member.name} · {created.member.email} · {trl(created.member.role)}
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
          <Button type="button" variant="ghost" onClick={() => router.push('/members')}>
            {t('backToList')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('invite')}</h1>
      {/* §S1-SEC1 — method="post" defense in depth (login/page.tsx pattern). */}
      <form method="post" action="" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            {t('field.email')}
          </label>
          <input
            id="email"
            type="email"
            autoComplete="off"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('email')}
          />
          {errors.email && (
            <p className="text-xs text-destructive">{errors.email.message ?? tp('retry')}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="name" className="text-sm font-medium">
            {t('field.name')}
          </label>
          <input
            id="name"
            type="text"
            autoComplete="off"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('name')}
          />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="role" className="text-sm font-medium">
            {t('field.role')}
          </label>
          <select
            id="role"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            {...register('role')}
          >
            {OrgRoleEnum.options.map((r) => (
              <option key={r} value={r} dir="auto">
                {trl(r)}
              </option>
            ))}
          </select>
          {errors.role && <p className="text-xs text-destructive">{errors.role.message}</p>}
        </div>

        {serverError && (
          <p className="text-sm text-destructive" role="alert" aria-live="assertive">
            {serverError}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('inviting') : t('invite')}
          </Button>
        </div>
      </form>
    </div>
  );
}
