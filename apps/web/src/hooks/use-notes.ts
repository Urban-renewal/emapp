'use client';

import type { CreateNote, UpdateNote } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toNoteViewModel, toNoteViewModels } from '@/adapters/note';
import type { AssignmentMemberLookup } from '@/adapters/project-assignment';
import {
  archiveNote,
  createNote,
  getNote,
  listNotes,
  updateNote,
  type NoteListPage,
} from '@/lib/api/notes';
import { useDisplayLocale } from '@/lib/locale';
import type { NoteViewModel } from '@/models/note.vm';

const NOTES_KEY = ['notes'] as const;

export function useNoteList(
  query: { limit?: number; cursor?: string } = {},
  userIdToMember?: Map<string, AssignmentMemberLookup>,
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: NoteListPage) => ({
      items: toNoteViewModels(data.items, locale, userIdToMember),
      page: data.page,
    }),
    [locale, userIdToMember],
  );
  return useQuery<NoteListPage, Error, { items: NoteViewModel[]; page: NoteListPage['page'] }>({
    queryKey: [...NOTES_KEY, 'list', query, locale],
    queryFn: () => listNotes(query),
    staleTime: 30_000,
    select,
  });
}

export function useNote(
  id: string | undefined,
  userIdToMember?: Map<string, AssignmentMemberLookup>,
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: import('@emapp/shared-types').Note) => toNoteViewModel(data, locale, userIdToMember),
    [locale, userIdToMember],
  );
  return useQuery({
    queryKey: [...NOTES_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useNote requires an id');
      return getNote(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNote) => createNote(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
    },
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: UpdateNote }) => updateNote(input.id, input.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
    },
  });
}

export function useArchiveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveNote(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
    },
  });
}
