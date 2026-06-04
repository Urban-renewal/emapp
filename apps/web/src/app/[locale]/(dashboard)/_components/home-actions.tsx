'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useHasPermission } from '@/hooks/use-permissions';

/**
 * IAM slice 5b — the ManagerHome action row, extracted into a client island
 * so it can gate on the actor's effective permissions (the home page itself
 * is a Server Component and can't call the hook).
 *
 * Changes vs the prior inline buttons:
 *  - "פרויקט חדש" (New Project) renders only for actors holding
 *    `projects.create` (agents/viewers no longer see a dead create button).
 *  - The "משימת שטח" (Field Task) button was a permanently-disabled
 *    "בקרוב" (coming soon) placeholder — Field Tasks is a Phase-2 feature
 *    that isn't wired. Ship-or-hide: removed until built.
 *
 * UX only; the BE guards `POST /projects` regardless (defense in depth).
 */
export function HomeActions() {
  const t = useTranslations('home');
  const canCreateProject = useHasPermission('projects.create');

  if (!canCreateProject) return null;

  return (
    <div className="flex flex-wrap gap-3">
      <Link href="/projects/new" className="btn btn-primary btn-lg">
        <Plus className="h-4 w-4" aria-hidden="true" />
        <span>{t('action.newProject')}</span>
      </Link>
    </div>
  );
}
