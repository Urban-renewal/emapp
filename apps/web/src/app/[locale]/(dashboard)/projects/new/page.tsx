'use client';

import { CreateProjectInput, type CreateProject, type ProjectType } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useCreateProject } from '@/hooks/use-projects';
import { ApiClientError } from '@/lib/api/projects';
import { applyValidationErrors } from '@/lib/errors';

const PROJECT_TYPES: ProjectType[] = ['tama38_1', 'tama38_2', 'pinui_binui'];

export default function NewProjectPage() {
  const t = useTranslations('projects');
  const tt = useTranslations('projects.types');
  const router = useRouter();
  const mutation = useCreateProject();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateProject>({
    resolver: zodResolver(CreateProjectInput),
    defaultValues: { type: 'tama38_2' },
  });

  async function onSubmit(values: CreateProject) {
    setServerError(null);
    try {
      const project = await mutation.mutateAsync(values);
      router.push(`/projects/${project.id}`);
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'validation_error') {
        const env = { code: e.code, message: e.message, details: e.details };
        const applied = applyValidationErrors(env, (field, message) => {
          setError(field as keyof CreateProject, { type: 'server', message });
        });
        if (applied.length === 0) setServerError(t('createFailed'));
      } else if (e instanceof ApiClientError) {
        setServerError(t('createFailed'));
      } else {
        setServerError(t('createFailed'));
      }
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('create')}</h1>
      {/* §S5-SEC1 — method="post" defense in depth (see login/page.tsx). */}
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
          {errors.name && (
            <p className="text-xs text-destructive">{errors.name.message ?? t('field.required')}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="type" className="text-sm font-medium">
            {t('field.type')}
          </label>
          <select
            id="type"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            {...register('type')}
          >
            {PROJECT_TYPES.map((pt) => (
              <option key={pt} value={pt}>
                {tt(pt)}
              </option>
            ))}
          </select>
          {errors.type && (
            <p className="text-xs text-destructive">{errors.type.message ?? t('field.required')}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="description" className="text-sm font-medium">
            {t('field.description')}
          </label>
          <textarea
            id="description"
            rows={4}
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('description')}
          />
          {errors.description && (
            <p className="text-xs text-destructive">{errors.description.message}</p>
          )}
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
