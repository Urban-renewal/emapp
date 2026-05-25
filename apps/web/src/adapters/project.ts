import type { Project, ProjectStatus, ProjectType } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { ProjectViewModel } from '@/models/project.vm';

/**
 * Wire → ViewModel adapter (per docs/05 §9.8). Pure function. No I/O,
 * no hooks. Components never see the raw wire shape — they consume
 * `ProjectViewModel`.
 *
 * Hebrew labels are owned HERE, not in i18n messages, because they
 * are a 1:1 mapping from a locked enum (D.18) to product-specific
 * Hebrew terminology — changing one without the other would silently
 * desynchronize the UI from the contract. The status enum is LAW
 * (D.18); the label set ships with it.
 */

const TYPE_LABELS: Record<ProjectType, string> = {
  tama38_1: 'תמ"א 38/1',
  tama38_2: 'תמ"א 38/2',
  pinui_binui: 'פינוי-בינוי',
};

// D.18: planning | gathering_signatures | approved | in_construction | completed | cancelled
const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'בתכנון',
  gathering_signatures: 'איסוף חתימות',
  approved: 'מאושר',
  in_construction: 'בבנייה',
  completed: 'הושלם',
  cancelled: 'בוטל',
};

const STATUS_COLORS: Record<ProjectStatus, ProjectViewModel['statusColor']> = {
  planning: 'gray',
  gathering_signatures: 'amber',
  approved: 'emerald',
  in_construction: 'emerald',
  completed: 'gray',
  cancelled: 'red',
};

export function toProjectViewModel(p: Project, locale: 'he' | 'en' = 'he'): ProjectViewModel {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    typeLabel: TYPE_LABELS[p.type],
    status: p.status,
    statusLabel: STATUS_LABELS[p.status],
    statusColor: STATUS_COLORS[p.status],
    description: p.description ?? null,
    isArchived: p.archivedAt !== null,
    createdRelative: formatRelative(p.createdAt, locale),
    createdAtIso: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
  };
}

export function toProjectViewModels(
  items: Project[],
  locale: 'he' | 'en' = 'he',
): ProjectViewModel[] {
  return items.map((p) => toProjectViewModel(p, locale));
}

/** Exported for adapter tests + future Storybook stories. */
export const PROJECT_TYPE_LABELS = TYPE_LABELS;
export const PROJECT_STATUS_LABELS = STATUS_LABELS;
export const PROJECT_STATUS_COLORS = STATUS_COLORS;
