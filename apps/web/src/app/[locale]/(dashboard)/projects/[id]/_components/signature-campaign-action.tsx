'use client';

import { Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useDocumentList } from '@/hooks/use-documents';
import { useCreateSignatureCampaign } from '@/hooks/use-signature-requests';

/**
 * S5b — SIGNATURE CAMPAIGN action. A button on the project-detail dashboard
 * (next to the S5a signature-progress board) that fans out ONE project document
 * to ALL active owners of the project.
 *
 * Flow: button → an inline panel to pick a PROJECT-scoped document → confirm →
 * `POST /api/v1/projects/:id/signature-campaign` → an aria-live toast that
 * reports DELIVERED links honestly ("{delivered} נשלחו"), warns about owners
 * with no channel ("{noChannel} ללא ערוץ — שלח ידנית"), and notes skipped. The
 * hook invalidates the signature-
 * requests queries AND the projects queries (so the S5a board + KPI counts
 * refetch).
 *
 * No dialog/select primitive exists in this codebase (see ExportXlsxButton), so
 * this mirrors that pattern: an inline expandable panel + an aria-live status
 * "toast", not a portal modal. The picker lists only the project's FINALISED,
 * non-archived documents (the only docs the BE will fan out).
 */
export function SignatureCampaignAction({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.campaign');
  const [open, setOpen] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string>('');
  const [toast, setToast] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  // Project-scoped documents only — these are the docs the BE accepts for a
  // campaign (a project-scoped doc with project_id === projectId).
  const { data: docs, isLoading: docsLoading } = useDocumentList({ projectId });
  const eligibleDocs = (docs?.items ?? []).filter(
    (d) => !d.isArchived && d.projectId === projectId,
  );

  const campaign = useCreateSignatureCampaign(projectId);

  async function onConfirm() {
    if (!selectedDocId || campaign.isPending) return;
    setToast(null);
    setErrored(false);
    try {
      const res = await campaign.mutateAsync({ documentId: selectedDocId });
      // HONEST: report `delivered` (links that actually reached a channel), NOT
      // `created` (rows inserted) — a `noChannel` owner (no email+phone / PII
      // decrypt failed) has a request but got NOTHING, and the copy says so +
      // "send manually". Mirrors the inbox delivery-OUTCOME honesty.
      setToast(
        t('result', {
          delivered: res.delivered,
          noChannel: res.noChannel,
          skipped: res.skipped,
        }),
      );
      setErrored(false);
      setOpen(false);
      setSelectedDocId('');
    } catch {
      setToast(t('failed'));
      setErrored(true);
    }
  }

  return (
    <div className="relative flex flex-col gap-2">
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="signature-campaign-toggle"
          className="btn btn-secondary btn-sm"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('cta')}</span>
        </button>
      </div>

      {open && (
        <div
          className="flex flex-col gap-2 rounded-md border p-3"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
        >
          <label
            htmlFor="campaign-doc"
            className="text-xs font-medium"
            style={{ color: 'var(--text)' }}
          >
            {t('pickDocument')}
          </label>
          {docsLoading ? (
            <div
              className="h-9 w-full animate-pulse rounded-md"
              style={{ background: 'var(--bg-subtle)' }}
              aria-hidden="true"
            />
          ) : eligibleDocs.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('noDocuments')}
            </p>
          ) : (
            <select
              id="campaign-doc"
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              data-testid="signature-campaign-doc-select"
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
            >
              <option value="" disabled>
                {t('selectPlaceholder')}
              </option>
              {eligibleDocs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={!selectedDocId || campaign.isPending}
              aria-busy={campaign.isPending}
              data-testid="signature-campaign-confirm"
              className="btn btn-primary btn-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {campaign.isPending ? t('sending') : t('confirm')}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSelectedDocId('');
              }}
              className="btn btn-ghost btn-sm"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <p
          role="status"
          aria-live="polite"
          data-testid="signature-campaign-toast"
          className="whitespace-nowrap rounded-md border px-2 py-1 text-[11px] shadow-sm"
          style={{
            color: errored ? 'var(--danger-700)' : 'var(--success-700)',
            background: 'var(--bg-surface)',
            borderColor: 'var(--border)',
          }}
        >
          {toast}
        </p>
      )}
    </div>
  );
}
