'use client';

import { DocumentTypeEnum, type DocumentType } from '@emapp/shared-types';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { DocumentDropzone } from '@/components/documents/document-dropzone';
import { Button } from '@/components/ui/button';
import { useBoardCompleteness } from '@/hooks/use-documents';

/**
 * S3 — generic scope-aware upload. The flat 19-option `<select>` defaulting to
 * `agreement` is GONE: the human picks a FILE and the system classifies it
 * (DH3) + dedups it (DH4) + derives the party, asking for a category only on
 * genuine ambiguity.
 *
 * This page is the ORG-scope entry (no project/apartment in the route). It still
 * honors the S2 board deep-links:
 *   - `?type=` pre-selects a type (board "העלה {missing}" → straight to confirm),
 *   - `?projectId=` scopes the upload to that project (board project card link).
 * The "gaps here" list (org scope) is the union of the board's per-party missing
 * required types — so even the ASK band leads with what the org actually needs.
 */
const TYPE_SET = new Set<string>(DocumentTypeEnum.options);

function parseType(raw: string | null): DocumentType | null {
  return raw && TYPE_SET.has(raw) ? (raw as DocumentType) : null;
}

export default function NewDocumentPage() {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const router = useRouter();
  const params = useSearchParams();

  const prefillType = parseType(params.get('type'));
  // `?projectId=` deep-link → scope the upload to that project (board links here).
  const projectId = params.get('projectId') ?? undefined;
  const scope = projectId ? 'project' : 'org';

  const board = useBoardCompleteness();

  // Org "gaps here" — the union of every party's still-missing required types.
  const gapTypes = useMemo<DocumentType[]>(() => {
    const seen = new Set<DocumentType>();
    const out: DocumentType[] = [];
    for (const party of board.data?.byParty ?? []) {
      for (const m of party.missingTypes) {
        if (!seen.has(m.type)) {
          seen.add(m.type);
          out.push(m.type);
        }
      }
    }
    return out;
  }, [board.data]);

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('upload')}</h1>
      <p className="text-xs text-text-muted">{t('dropzone.hint')}</p>

      <DocumentDropzone
        scope={scope}
        projectId={projectId}
        gapTypes={gapTypes}
        prefillType={prefillType}
        onUploaded={({ id }) => router.push(`/documents/${id}`)}
      />

      <div className="flex items-center justify-end">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          {tp('cancel')}
        </Button>
      </div>
    </div>
  );
}
