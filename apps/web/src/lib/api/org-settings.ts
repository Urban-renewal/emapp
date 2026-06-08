/**
 * Org settings API client — P6-1 (the per-org config seam's admin surface).
 *
 * Routes (org-tier, admin permission `org.settings.read` / `.update`):
 *   GET   /api/v1/org/settings → { data: OrgSettings }   (fully RESOLVED)
 *   PATCH /api/v1/org/settings → { data: OrgSettings }   (partial patch in)
 *
 * The GET always returns the fully-resolved tree (defaults + overrides) so the
 * FE renders a complete config even for an org that overrode nothing. The PATCH
 * body is a PARTIAL — only the namespaces/leaves being changed — validated
 * server-side by `OrgSettingsPatchSchema`. Defensive Zod parse on every
 * response per the FE architecture rule (every wire shape re-parsed).
 */
import { OrgSettingsSchema, type OrgSettings, type OrgSettingsPatch } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

const OrgSettingsDataSchema = z.object({ data: OrgSettingsSchema });

export async function getOrgSettings(): Promise<OrgSettings> {
  const res = await apiClient.get<unknown>('/org/settings');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OrgSettingsDataSchema.parse({ data: res.data }).data;
}

export async function updateOrgSettings(patch: OrgSettingsPatch): Promise<OrgSettings> {
  const res = await apiClient.patch<unknown>('/org/settings', patch);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OrgSettingsDataSchema.parse({ data: res.data }).data;
}
