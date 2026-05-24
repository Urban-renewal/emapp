'use client';

import { CreateBuildingInput, type CreateBuilding } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useCreateBuilding } from '@/hooks/use-buildings';
import { ApiClientError } from '@/lib/api/projects';
import { applyValidationErrors } from '@/lib/errors';

export default function NewBuildingPage() {
  const t = useTranslations('buildings');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const router = useRouter();
  const mutation = useCreateBuilding(projectId);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateBuilding>({
    resolver: zodResolver(CreateBuildingInput),
  });

  async function onSubmit(values: CreateBuilding) {
    setServerError(null);
    try {
      const building = await mutation.mutateAsync(values);
      router.push(`/buildings/${building.id}`);
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'validation_error') {
        const env = { code: e.code, message: e.message, details: e.details };
        const applied = applyValidationErrors(env, (field, message) => {
          setError(field as keyof CreateBuilding, { type: 'server', message });
        });
        if (applied.length === 0) setServerError(t('createFailed'));
      } else {
        setServerError(t('createFailed'));
      }
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('create')}</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="address" className="text-sm font-medium">
            {t('field.address')}
          </label>
          <input
            id="address"
            type="text"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('address')}
          />
          {errors.address && (
            <p className="text-xs text-destructive">
              {errors.address.message ?? tp('field.required')}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="city" className="text-sm font-medium">
            {t('field.city')}
          </label>
          <input
            id="city"
            type="text"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('city')}
          />
          {errors.city && (
            <p className="text-xs text-destructive">
              {errors.city.message ?? tp('field.required')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label htmlFor="block" className="text-sm font-medium">
              {t('field.block')}
            </label>
            <input
              id="block"
              type="text"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('block')}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="parcel" className="text-sm font-medium">
              {t('field.parcel')}
            </label>
            <input
              id="parcel"
              type="text"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('parcel')}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="subparcel" className="text-sm font-medium">
              {t('field.subparcel')}
            </label>
            <input
              id="subparcel"
              type="text"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('subparcel')}
            />
          </div>
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
