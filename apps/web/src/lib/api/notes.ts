/**
 * Notes API client — Phase 4e.
 *
 * Routes (org-scoped):
 *   GET    /api/v1/notes              → { data, page }
 *   POST   /api/v1/notes              → { data: Note }   (Manager/Agent)
 *   GET    /api/v1/notes/:id          → { data: Note }
 *   PATCH  /api/v1/notes/:id          → { data: Note }   (Manager OR author)
 *   DELETE /api/v1/notes/:id          → 204               (Manager OR author)
 *
 * Defensive Zod parse on every response (per docs/ARCHITECTURE-MAP §1).
 */
import { NoteSchema, type CreateNote, type Note, type UpdateNote } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const NoteDataSchema = z.object({ data: NoteSchema });

export interface NoteListPage {
  items: Note[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listNotes(
  query: { limit?: number; cursor?: string } = {},
): Promise<NoteListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/notes${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(NoteSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getNote(id: string): Promise<Note> {
  const res = await apiClient.get<unknown>(`/notes/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return NoteDataSchema.parse({ data: res.data }).data;
}

export async function createNote(body: CreateNote): Promise<Note> {
  const res = await apiClient.postIdempotent<unknown>(`/notes`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return NoteDataSchema.parse({ data: res.data }).data;
}

export async function updateNote(id: string, body: UpdateNote): Promise<Note> {
  const res = await apiClient.patch<unknown>(`/notes/${id}`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return NoteDataSchema.parse({ data: res.data }).data;
}

export async function archiveNote(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/notes/${id}`);
  if (isOk(res)) return;
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}
