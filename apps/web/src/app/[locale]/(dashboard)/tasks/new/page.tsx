'use client';

import { CreateTaskInput, type CreateTask } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useCreateTask } from '@/hooks/use-tasks';
import type { TaskPriorityLevel } from '@/models/task.vm';

/**
 * Create-task form — Manager-only (D.17 — tasks.create=MGR; BE 403s
 * Agent/Viewer regardless). The FE shows the form to everyone; the
 * `forbidden` error code maps to a localized message via
 * `useApiErrorHandler`.
 *
 * Wire body is `CreateTaskInput.strict()`; the form covers title +
 * description + priority. Optional fields (dueAt / type / project /
 * apartment / assigneeIds) are deferred to the detail page or a
 * future wizard — keeping the create form lean.
 */
const PRIORITIES: TaskPriorityLevel[] = [1, 2, 3];

export default function NewTaskPage() {
  const t = useTranslations('tasks');
  const tt = useTranslations('tasks.priority');
  const router = useRouter();
  const mutation = useCreateTask();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateTask>({
    resolver: zodResolver(CreateTaskInput),
    defaultValues: { priority: 2 },
  });

  const { serverError, handle, reset } = useApiErrorHandler<CreateTask>({
    setError,
    codeOverrides: {
      forbidden: () => t('forbiddenCreate'),
    },
    fallback: () => t('createFailed'),
  });

  async function onSubmit(values: CreateTask) {
    reset();
    try {
      const task = await mutation.mutateAsync({
        ...values,
        // RHF gives strings for number inputs; the resolver normalises
        // most of it, but `priority` is a select that can serialise as
        // `"2"` — coerce explicitly so the wire matches `z.number()`.
        priority: typeof values.priority === 'string' ? Number(values.priority) : values.priority,
      });
      router.push(`/tasks/${task.id}`);
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
          <label htmlFor="title" className="text-sm font-medium">
            {t('field.title')}
          </label>
          <input
            id="title"
            type="text"
            className="w-full rounded-md border px-3 py-2 text-sm"
            {...register('title')}
          />
          {errors.title && (
            <p className="text-xs text-destructive">
              {errors.title.message ?? t('field.required')}
            </p>
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

        <div className="space-y-1">
          <label htmlFor="priority" className="text-sm font-medium">
            {t('field.priority')}
          </label>
          <select
            id="priority"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            {...register('priority', { valueAsNumber: true })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p} dir="auto">
                {tt(String(p))}
              </option>
            ))}
          </select>
          {errors.priority && <p className="text-xs text-destructive">{errors.priority.message}</p>}
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
            {isSubmitting ? t('creating') : t('create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
