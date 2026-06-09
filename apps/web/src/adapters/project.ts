import type { Project, ProjectListItem, ProjectStatus, ProjectType } from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
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

export function toProjectViewModel(
  p: Project | ProjectListItem,
  locale: 'he' | 'en' = 'he',
): ProjectViewModel {
  const isListItem = (x: Project | ProjectListItem): x is ProjectListItem =>
    'buildingsCount' in x && typeof (x as ProjectListItem).buildingsCount === 'number';
  return {
    id: p.id,
    // §SEC-M4 — strip bidi codepoints. Project name is shown in
    // <option dir="auto"> on the imports/new page (project picker).
    name: stripBidiOverrides(p.name),
    type: p.type,
    typeLabel: TYPE_LABELS[p.type],
    status: p.status,
    statusLabel: STATUS_LABELS[p.status],
    statusColor: STATUS_COLORS[p.status],
    targetConsentPct: p.targetSignaturePct ?? null,
    // Owner-approved staged overlay (Gate-6). Already shape-validated by the
    // wire Zod parse; null → empty array so components iterate uniformly. The
    // user-authored label is bidi-stripped like every other free-text field
    // (§SEC-M4 / RTL-spoofing defence) before it reaches the progress bar.
    signatureMilestones: (p.signatureMilestones ?? []).map((m) =>
      m.label ? { ...m, label: stripBidiOverrides(m.label) } : m,
    ),
    description: p.description ? stripBidiOverrides(p.description) : null,
    isArchived: p.archivedAt !== null,
    createdRelative: formatRelative(p.createdAt, locale),
    createdAtIso: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
    // Stats — present only when the BE returned ProjectListItem (list/get).
    // Adapter is the single seam — components branch on undefined to render "—".
    ...(isListItem(p)
      ? {
          buildingsCount: p.buildingsCount,
          unitsCount: p.unitsCount,
          signaturesPendingCount: p.signaturesPendingCount,
          signaturesSignedCount: p.signaturesSignedCount,
          agentsCount: p.agentsCount,
        }
      : {}),
  };
}

export function toProjectViewModels(
  items: Array<Project | ProjectListItem>,
  locale: 'he' | 'en' = 'he',
): ProjectViewModel[] {
  return items.map((p) => toProjectViewModel(p, locale));
}

/** Exported for adapter tests + future Storybook stories. */
export const PROJECT_TYPE_LABELS = TYPE_LABELS;
export const PROJECT_STATUS_LABELS = STATUS_LABELS;
export const PROJECT_STATUS_COLORS = STATUS_COLORS;
