/**
 * Wire → ViewModel adapter for the owner→project summary (Doc 05 §9.8).
 *
 * Pure function. Reuses the project adapter's locked enum→label maps
 * (PROJECT_TYPE_LABELS / PROJECT_STATUS_LABELS / PROJECT_STATUS_INTENTS — D.18 is
 * LAW; the labels ship with the enum) so the owner dossier renders a project's
 * type/status identically to the projects list. The project `name` is
 * bidi-stripped like every other user-authored string (§SEC-M4 / RTL-spoofing
 * defence). No owner PII is present on this shape.
 */
import type { OwnerProjectSummary } from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
import type { OwnerProjectViewModel } from '@/models/owner-project.vm';

import { PROJECT_STATUS_INTENTS, PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from './project';

export function toOwnerProjectViewModel(p: OwnerProjectSummary): OwnerProjectViewModel {
  return {
    id: p.id,
    name: stripBidiOverrides(p.name),
    type: p.type,
    typeLabel: PROJECT_TYPE_LABELS[p.type],
    status: p.status,
    statusLabel: PROJECT_STATUS_LABELS[p.status],
    intent: PROJECT_STATUS_INTENTS[p.status],
  };
}

export function toOwnerProjectViewModels(items: OwnerProjectSummary[]): OwnerProjectViewModel[] {
  return items.map(toOwnerProjectViewModel);
}
