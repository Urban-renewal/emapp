'use client';

import { CreateContractorInput, type CreateContractor } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useCreateContractor } from '@/hooks/use-contractors';

export default function NewContractorPage() {
  const t = useTranslations('contractors');
  const router = useRouter();
  const mutation = useCreateContractor();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateContractor>({ resolver: zodResolver(CreateContractorInput) });

  const { serverError, handle, reset } = useApiErrorHandler<CreateContractor>({
    setError,
    codeOverrides: {
      forbidden: () => t('forbiddenCreate'),
      contractor_email_exists: (set) => {
        set?.('contactEmail', { type: 'server', message: t('emailExists') });
      },
    },
    fallback: () => t('createFailed'),
  });

  async function onSubmit(values: CreateContractor) {
    reset();
    try {
      const c = await mutation.mutateAsync(values);
      router.push(`/contractors/${c.id}`);
    } catch (e) {
      handle(e);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('create')}</h1>
      <form method="post" action="" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="name" className="text-sm font-medium">
            {t('field.name')}
          </label>
          <input
            id="name"
            type="text"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('name')}
          />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="contactEmail" className="text-sm font-medium">
            {t('field.contactEmail')}
          </label>
          <input
            id="contactEmail"
            type="email"
            autoComplete="off"
            dir="ltr"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('contactEmail')}
          />
          {errors.contactEmail && (
            <p className="text-xs text-destructive">{errors.contactEmail.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="contactPhone" className="text-sm font-medium">
            {t('field.contactPhone')}
          </label>
          <input
            id="contactPhone"
            type="tel"
            autoComplete="off"
            dir="ltr"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('contactPhone')}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="specialty" className="text-sm font-medium">
            {t('field.specialty')}
          </label>
          <input
            id="specialty"
            type="text"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('specialty')}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="companyId" className="text-sm font-medium">
            {t('field.companyId')}
          </label>
          <input
            id="companyId"
            type="text"
            dir="ltr"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('companyId')}
          />
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
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('creating') : t('create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
