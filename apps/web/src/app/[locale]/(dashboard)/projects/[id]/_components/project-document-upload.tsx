'use client';

import { DocumentTypeEnum, type DocumentMime, type DocumentType } from '@emapp/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { DocumentDropzone } from '@/components/documents/document-dropzone';
import { useToast } from '@/components/ui/action-toast';
import { useDocumentChecklist } from '@/hooks/use-projects';

/**
 * S3 — project-scoped GENERIC document upload (replaces the Slice-5c hardcoded
 * `type:'agreement'` control). On the project detail page the manager picks a
 * file; the shared `DocumentDropzone` classifies it (DH3) + dedups it (DH4) +
 * derives the party, PRE-SCOPED to THIS project (projectId set, apartmentId
 * null) — so the doc hangs off the project WITHOUT leaving for /documents/new
 * and WITHOUT asking a category the system already knows.
 *
 * The "gaps here" list is THIS project's advisory checklist `missing` types, so
 * the ambiguous-band picker leads with what the project actually still needs.
 */
const TYPE_SET = new Set<string>(DocumentTypeEnum.options);

/**
 * Pure seam between the UI and the upload hook, PRESERVED from Slice 5c (its spec
 * `project-document-upload.spec.ts` pins this contract): maps (projectId, file,
 * type, mime) → the EXACT `useUploadDocument().mutate` arg object, pre-scoped to
 * the project. apartmentId is an explicit `null` (project-scoped, NOT
 * apartment-scoped, and NOT the org-level both-null upload /documents/new makes).
 * The S3 dropzone composes the SAME pre-scoping inline; this stays exported so
 * the seam test remains the single contract for "project-scoped, never org".
 */
export function buildProjectScopedUploadArgs(args: {
  projectId: string;
  file: File;
  type: DocumentType;
  mimeType: DocumentMime;
}): {
  file: File;
  type: DocumentType;
  mimeType: DocumentMime;
  projectId: string;
  apartmentId: null;
} {
  return {
    file: args.file,
    type: args.type,
    mimeType: args.mimeType,
    projectId: args.projectId,
    apartmentId: null,
  };
}

const PROJECTS_KEY = ['projects'] as const;

export function ProjectDocumentUpload({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.docUpload');
  const qc = useQueryClient();
  const toast = useToast();
  const checklist = useDocumentChecklist(projectId);

  // THIS project's still-missing required types → the dropzone's "gaps here".
  const gapTypes = useMemo<DocumentType[]>(() => {
    const out: DocumentType[] = [];
    for (const m of checklist.data?.missing ?? []) {
      if (TYPE_SET.has(m.type)) out.push(m.type as DocumentType);
    }
    return out;
  }, [checklist.data]);

  return (
    <DocumentDropzone
      scope="project"
      projectId={projectId}
      gapTypes={gapTypes}
      onUploaded={() => {
        // The hook already invalidates ['documents'] + the checklist; additionally
        // refetch the S5a signature-progress board for this project (a new project
        // doc can change the campaign surface / counts).
        qc.invalidateQueries({ queryKey: [...PROJECTS_KEY, 'signature-progress', projectId] });
        toast.show({ message: t('uploaded') });
      }}
    />
  );
}
