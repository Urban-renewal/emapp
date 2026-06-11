/**
 * Owner→Project summary ViewModel — Doc 05 §9.8.
 *
 * The wire shape is `OwnerProjectSummary` ({ id, name, type, status }) — the
 * DISTINCT projects an owner is tied to via active ownerships. It carries NO
 * owner PII (the endpoint answers "which projects", not "who"). The VM adds the
 * Hebrew type/status labels + status colour (reused from the project adapter so
 * the owner dossier renders projects exactly like the projects list).
 */
import type { ProjectStatus, ProjectType } from '@emapp/shared-types';

import type { ProjectViewModel } from './project.vm';

export interface OwnerProjectViewModel {
  id: string;
  name: string;
  type: ProjectType;
  typeLabel: string;
  status: ProjectStatus;
  statusLabel: string;
  statusColor: ProjectViewModel['statusColor'];
}
