'use client';

import {
  ApartmentStatusEnum,
  CreateApartmentInput,
  type ApartmentStatus,
  type CreateApartment,
} from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { APARTMENT_STATUS_LABELS_HE } from '@/adapters/apartment';
import { Button } from '@/components/ui/button';
import { useCreateApartment } from '@/hooks/use-apartments';
import { ApiClientError } from '@/lib/api/projects';
import { applyValidationErrors } from '@/lib/errors';

const STATUS_OPTIONS: ApartmentStatus[] = [...ApartmentStatusEnum.options];

export default function NewApartmentPage() {
  const t = useTranslations('apartments');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const buildingId = params?.id ?? '';
  const router = useRouter();
  const mutation = useCreateApartment(buildingId);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateApartment>({
    resolver: zodResolver(CreateApartmentInput),
    defaultValues: { status: 'pending' },
  });

  async function onSubmit(values: CreateApartment) {
    setServerError(null);
    try {
      const apt = await mutation.mutateAsync(values);
      router.push(`/apartments/${apt.id}`);
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'validation_error') {
        const env = { code: e.code, message: e.message, details: e.details };
        const applied = applyValidationErrors(env, (field, message) => {
          setError(field as keyof CreateApartment, { type: 'server', message });
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
          <label htmlFor="number" className="text-sm font-medium">
            {t('field.number')}
          </label>
          <input
            id="number"
            type="text"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('number')}
          />
          {errors.number && (
            <p className="text-xs text-destructive">
              {errors.number.message ?? tp('field.required')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label htmlFor="floor" className="text-sm font-medium">
              {t('field.floor')}
            </label>
            <input
              id="floor"
              type="number"
              step="1"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('floor', {
                setValueAs: (v: unknown) => (v === '' || v === null ? null : Number(v)),
              })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="rooms" className="text-sm font-medium">
              {t('field.rooms')}
            </label>
            <input
              id="rooms"
              type="number"
              step="0.5"
              min="0"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('rooms', {
                setValueAs: (v: unknown) => (v === '' || v === null ? null : Number(v)),
              })}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="sizeSqm" className="text-sm font-medium">
              {t('field.sizeSqm')}
            </label>
            <input
              id="sizeSqm"
              type="number"
              step="0.1"
              min="0"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('sizeSqm', {
                setValueAs: (v: unknown) => (v === '' || v === null ? null : Number(v)),
              })}
            />
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="status" className="text-sm font-medium">
            {t('field.status')}
          </label>
          <select
            id="status"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            {...register('status')}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {APARTMENT_STATUS_LABELS_HE[s]}
              </option>
            ))}
          </select>
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
