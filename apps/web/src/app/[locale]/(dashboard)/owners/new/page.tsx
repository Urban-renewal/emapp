'use client';

import { CreateOwnerInput, type CreateOwner } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useCreateOwner } from '@/hooks/use-owners';
import { ApiClientError } from '@/lib/api/projects';
import { applyValidationErrors } from '@/lib/errors';

export default function NewOwnerPage() {
  const t = useTranslations('owners');
  const tp = useTranslations('projects');
  const router = useRouter();
  const mutation = useCreateOwner();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateOwner>({
    resolver: zodResolver(CreateOwnerInput),
  });

  async function onSubmit(values: CreateOwner) {
    setServerError(null);
    try {
      const owner = await mutation.mutateAsync(values);
      router.push(`/owners/${owner.id}`);
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'validation_error') {
        const env = { code: e.code, message: e.message, details: e.details };
        const applied = applyValidationErrors(env, (field, message) => {
          setError(field as keyof CreateOwner, { type: 'server', message });
        });
        if (applied.length === 0) setServerError(t('createFailed'));
      } else if (e instanceof ApiClientError && e.code === 'owner_exists') {
        // BE returns this when (org_id, national_id_hash) collides.
        setError('national_id', { type: 'server', message: t('field.idExists') });
      } else {
        setServerError(t('createFailed'));
      }
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('create')}</h1>
      <p className="text-xs text-muted-foreground">{t('piiNote')}</p>
      {/* §S5-SEC1 — method="post" defense in depth: this form carries
          national_id (D.19 PII). A GET-fallback would leak it to URL
          query string + logs + CDN caches. See login/page.tsx §S1-SEC1
          for the full rationale. */}
      <form method="post" action="" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="name" className="text-sm font-medium">
            {t('field.name')}
          </label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('name')}
          />
          {errors.name && (
            <p className="text-xs text-destructive">
              {errors.name.message ?? tp('field.required')}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="national_id" className="text-sm font-medium">
            {t('field.nationalId')}
          </label>
          <input
            id="national_id"
            type="text"
            inputMode="numeric"
            maxLength={9}
            autoComplete="off"
            className="w-full rounded-md border px-3 py-2 font-mono text-sm"
            dir="ltr"
            {...register('national_id')}
          />
          {errors.national_id && (
            <p className="text-xs text-destructive">
              {errors.national_id.message ?? tp('field.required')}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="phone" className="text-sm font-medium">
            {t('field.phone')}
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="w-full rounded-md border px-3 py-2 font-mono text-sm"
            dir="ltr"
            {...register('phone')}
          />
          {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            {t('field.email')}
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('email')}
          />
          {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="notes" className="text-sm font-medium">
            {t('field.notes')}
          </label>
          <textarea
            id="notes"
            rows={3}
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('notes')}
          />
        </div>

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {tp('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? tp('creating') : tp('create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
