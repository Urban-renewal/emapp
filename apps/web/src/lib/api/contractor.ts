/**
 * D2-DEF-1 — contractor read-tier API client.
 *
 * A contractor has NO org/tenant session: the share-access token (from the
 * share-link URL) IS the credential, presented as `Authorization: Bearer
 * <token>` (the Next proxy forwards it verbatim to the BE
 * ContractorAuthGuard). Every response is defensively Zod-parsed.
 *
 * The token is held by the calling page in component state only (it comes
 * from the URL) — never written to the TanStack cache or storage here.
 */
import {
  ContractorDocumentSchema,
  ContractorDownloadSchema,
  ContractorProgressSchema,
  ContractorProjectViewSchema,
  type ContractorDocument,
  type ContractorDownload,
  type ContractorProgress,
  type ContractorProjectView,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

function auth(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

const ProjectData = z.object({ data: ContractorProjectViewSchema });
const ProgressData = z.object({ data: ContractorProgressSchema });
const DocumentsData = z.object({ data: z.array(ContractorDocumentSchema) });
const DownloadData = z.object({ data: ContractorDownloadSchema });

export async function getContractorProject(token: string): Promise<ContractorProjectView> {
  const res = await apiClient.get<unknown>('/contractor/project', auth(token));
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ProjectData.parse({ data: res.data }).data;
}

export async function getContractorProgress(token: string): Promise<ContractorProgress> {
  const res = await apiClient.get<unknown>('/contractor/progress', auth(token));
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ProgressData.parse({ data: res.data }).data;
}

export async function getContractorDocuments(token: string): Promise<ContractorDocument[]> {
  const res = await apiClient.get<unknown>('/contractor/documents', auth(token));
  // The list endpoint returns a bare `{ data: [...] }` (no page envelope).
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DocumentsData.parse({ data: res.data }).data;
}

export async function getContractorDownloadUrl(
  token: string,
  docId: string,
): Promise<ContractorDownload> {
  const res = await apiClient.get<unknown>(`/contractor/documents/${docId}/download`, auth(token));
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DownloadData.parse({ data: res.data }).data;
}
