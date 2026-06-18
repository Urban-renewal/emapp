'use client';

import { CreateOwnerInput, type CreateOwner } from '@emapp/shared-types';
import { isValidIsraeliId } from '@emapp/validators';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useCreateOwner } from '@/hooks/use-owners';
import { emptyToUndefined } from '@/lib/forms';

export default function NewOwnerPage() {
  const t = useTranslations('owners');
  const tp = useTranslations('projects');
  const router = useRouter();
  const mutation = useCreateOwner();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateOwner>({
    resolver: zodResolver(CreateOwnerInput),
  });

  // §D.14 anti-enumeration — a duplicate national_id (BE `owner_exists`, 409)
  // must NOT be surfaced as a per-field "this exact ID already exists" oracle:
  // national_id is PII (D.19) and that message would let an authenticated
  // insider probe which IDs are on file. Show a GENERIC top-level error
  // instead — the same message whether the create failed on duplicate, RBAC,
  // or anything else. (Removing the codeOverride lets `owner_exists` fall
  // through to `fallback`, which is exactly this generic message.)
  const { serverError, handle, reset } = useApiErrorHandler<CreateOwner>({
    setError,
    fallback: () => t('addGenericError'),
  });

  async function onSubmit(values: CreateOwner) {
    reset();
    // FINDING-3b — client-side national_id MOD-10 (Luhn) check-digit guard,
    // reusing the canonical @emapp/validators implementation (BE enforces the
    // same in its DTO refine). The zod resolver only checks the 9-digit SHAPE,
    // so an invalid-checksum ID like 123456789 would otherwise be POSTed.
    // S3a — national_id is OPTIONAL (owner shells), so only validate when one
    // was actually entered.
    if (values.national_id && !isValidIsraeliId(values.national_id)) {
      setError('national_id', { type: 'validate', message: t('field.invalidId') });
      return;
    }
    try {
      const owner = await mutation.mutateAsync(values);
      router.push(`/owners/${owner.id}`);
    } catch (e) {
      handle(e);
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
            aria-invalid={errors.national_id ? true : undefined}
            {...register('national_id')}
          />
          {errors.national_id && (
            <p className="text-xs text-destructive" role="alert">
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
            {...register('phone', { setValueAs: emptyToUndefined })}
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
            {...register('email', { setValueAs: emptyToUndefined })}
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

        {serverError && (
          <p className="text-sm text-destructive" role="alert" aria-live="assertive">
            {serverError}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {tp('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('creating') : t('create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
