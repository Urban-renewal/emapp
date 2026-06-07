/**
 * D2-DEF-1 — contractor read-tier API client.
 *
 * A contractor has NO org/tenant session. The share-access token is the
 * credential, but as of Phase 3 #5 it is NO LONGER passed as a `Bearer`
 * header from the URL: the share-link landing (`share/[token]/route.ts`)
 * exchanged the URL token for an **httpOnly** cookie
 * (`contractor_access_token`). These same-origin calls carry that cookie
 * automatically (`credentials: 'same-origin'` in api-client); the Next proxy
 * forwards the Cookie header verbatim to the BE ContractorAuthGuard, which
 * reads `req.cookies['contractor_access_token']`. The token is never in JS —
 * httpOnly — so nothing here ever holds or forwards it.
 *
 * Every response is defensively Zod-parsed.
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

const ProjectData = z.object({ data: ContractorProjectViewSchema });
const ProgressData = z.object({ data: ContractorProgressSchema });
const DocumentsData = z.object({ data: z.array(ContractorDocumentSchema) });
const DownloadData = z.object({ data: ContractorDownloadSchema });

export async function getContractorProject(): Promise<ContractorProjectView> {
  const res = await apiClient.get<unknown>('/contractor/project');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ProjectData.parse({ data: res.data }).data;
}

export async function getContractorProgress(): Promise<ContractorProgress> {
  const res = await apiClient.get<unknown>('/contractor/progress');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ProgressData.parse({ data: res.data }).data;
}

export async function getContractorDocuments(): Promise<ContractorDocument[]> {
  const res = await apiClient.get<unknown>('/contractor/documents');
  // The list endpoint returns a bare `{ data: [...] }` (no page envelope).
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DocumentsData.parse({ data: res.data }).data;
}

export async function getContractorDownloadUrl(docId: string): Promise<ContractorDownload> {
  const res = await apiClient.get<unknown>(`/contractor/documents/${docId}/download`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return DownloadData.parse({ data: res.data }).data;
}
