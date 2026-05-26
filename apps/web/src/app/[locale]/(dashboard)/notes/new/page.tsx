'use client';

import { CreateNoteInput, type CreateNote } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useCreateNote } from '@/hooks/use-notes';

/**
 * Create-note form — Manager + Agent (D.17 — notes.create=MA; Viewer
 * 403s). The form is visible to all roles; the `forbidden` error code
 * maps to a localized message via `useApiErrorHandler`.
 *
 * Wire body is `CreateNoteInput.strict()`. The form covers body +
 * pinned; project/apartment scoping is deferred to a future
 * project/apartment-detail "attach a note" flow.
 */
export default function NewNotePage() {
  const t = useTranslations('notes');
  const router = useRouter();
  const mutation = useCreateNote();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateNote>({
    resolver: zodResolver(CreateNoteInput),
    defaultValues: { pinned: false },
  });

  const { serverError, handle, reset } = useApiErrorHandler<CreateNote>({
    setError,
    codeOverrides: { forbidden: () => t('forbiddenCreate') },
    fallback: () => t('createFailed'),
  });

  async function onSubmit(values: CreateNote) {
    reset();
    try {
      const note = await mutation.mutateAsync(values);
      router.push(`/notes/${note.id}`);
    } catch (e) {
      handle(e);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('create')}</h1>
      {/* §S1-SEC1 — method="post" defense in depth. */}
      <form method="post" action="" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="body" className="text-sm font-medium">
            {t('field.body')}
          </label>
          <textarea
            id="body"
            rows={8}
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('body')}
          />
          {errors.body && (
            <p className="text-xs text-destructive">{errors.body.message ?? t('field.required')}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input id="pinned" type="checkbox" className="rounded" {...register('pinned')} />
          <label htmlFor="pinned" className="text-sm">
            {t('field.pinned')}
          </label>
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
