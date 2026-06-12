'use client';

/**
 * 7c F3 — the נסח-טאבו review flow on the APARTMENT page (D-P5.1: AI parse +
 * MANDATORY human confirm).
 *
 * Flow (each step a separate, visible affordance):
 *   1. No draft extraction → pick a FINALIZED apartment-scoped doc (the
 *      uploaded נסח) → "צור חילוץ" (POST /apartments/:id/tabu-extractions).
 *   2. Draft exists → "הרץ פיענוח" (POST /tabu-extractions/:id/extract —
 *      stub engine, zero egress).
 *   3. Review table (GET /tabu-extractions/:id/rows — decrypted PII, so it
 *      sits behind the per-session step-up unlock; the F1 modal opens on
 *      403 `pii_step_up_required` and the fetch retries on verify).
 *   4. Inline row edit (PATCH …/rows/:rowId).
 *      SECURITY: when `nationalId` arrives MASKED (contains '•', D.19/D.47
 *      role-fidelity), the ת.ז. field is READ-ONLY — a masked actor must
 *      never round-trip bullets into the PATCH (it would overwrite the real
 *      encrypted value with '•••••••NN'). Name/shares stay editable.
 *   5. "אשר וכתוב בעלויות" (POST …/confirm) — preceded by the summary line
 *      ("יחליף את בעלי הדירה הנוכחיים — N בעלים…"). On 200 the owners list
 *      refreshes (ownerships query invalidation); on 409
 *      `tabu_extraction_not_draft` we show "כבר אושר" (the idempotency
 *      contract — an INFO, not an error).
 *
 * Mount contract: the PAGE renders this section only for actors holding
 * `apartments.update` (create/extract/edit/confirm are writes; the BE
 * AuthorizationGuard remains authoritative).
 */
import type { TabuExtractionReviewRow, UpdateTabuExtractionRow } from '@emapp/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isStepUpCancelled, useStepUpUnlock } from '@/components/step-up-unlock';
import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { useDocumentList } from '@/hooks/use-documents';
import {
  useCreateTabuExtraction,
  useRunTabuExtraction,
  useTabuExtractions,
} from '@/hooks/use-tabu-extractions';
import { ApiClientError } from '@/lib/api/errors';
import {
  confirmTabuExtraction,
  listTabuExtractionRows,
  TABU_NOT_DRAFT_CODE,
  updateTabuExtractionRow,
} from '@/lib/api/tabu-extractions';
import { stripBidiOverrides } from '@/lib/bidi';

/** A •-masked national id (D.19/D.47 role-fidelity masking). */
export function isMaskedNationalId(value: string | null): boolean {
  return value !== null && value.includes('•');
}

/** Exact fraction sum of the parsed shares (reduced), or null when any row
 *  is missing its fraction. {num:1,den:1} ⇔ the shares cover the whole. */
export function sumShares(
  rows: ReadonlyArray<Pick<TabuExtractionReviewRow, 'shareNumerator' | 'shareDenominator'>>,
): { num: number; den: number } | null {
  let num = 0;
  let den = 1;
  for (const r of rows) {
    if (
      r.shareNumerator === null ||
      r.shareDenominator === null ||
      !Number.isInteger(r.shareNumerator) ||
      !Number.isInteger(r.shareDenominator) ||
      r.shareDenominator <= 0
    ) {
      return null;
    }
    num = num * r.shareDenominator + r.shareNumerator * den;
    den = den * r.shareDenominator;
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  return { num, den };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x === 0 ? 1 : x;
}

type RowsState = 'idle' | 'loading' | 'ready' | 'error';
type Notice = { kind: 'ok' | 'info' | 'error'; text: string } | null;

interface EditDraft {
  name: string;
  nationalId: string;
  shareNumerator: string;
  shareDenominator: string;
}

export function TabuReviewSection({ apartmentId }: { apartmentId: string }) {
  const t = useTranslations('tabu');
  const qc = useQueryClient();
  const stepUp = useStepUpUnlock();

  const { data: extractions, isLoading: listLoading } = useTabuExtractions(apartmentId);
  const draft = extractions?.find((x) => x.status === 'draft') ?? null;

  // Doc picker source — the apartment's documents (the BE validates the
  // chosen doc is FINALIZED + apartment-scoped + sensitive-gated on create).
  const { data: docs } = useDocumentList({ apartmentId, limit: 50 });
  const [selectedDocId, setSelectedDocId] = useState('');

  const create = useCreateTabuExtraction(apartmentId);
  const run = useRunTabuExtraction();

  const [rows, setRows] = useState<TabuExtractionReviewRow[] | null>(null);
  const [rowsState, setRowsState] = useState<RowsState>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [savingRow, setSavingRow] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function loadRows(extractionId: string) {
    setNotice(null);
    setRowsState('loading');
    try {
      // 403 pii_step_up_required → the F1 modal opens; on verify the GET
      // retries and the decrypted rows land here.
      const next = await stepUp.withStepUp(() => listTabuExtractionRows(extractionId));
      setRows(next);
      setRowsState('ready');
      setEditingId(null);
      setEditDraft(null);
    } catch (e) {
      if (isStepUpCancelled(e)) {
        setRowsState('idle'); // back to the "show rows" affordance — not an error
        return;
      }
      setRowsState('error');
      setNotice({ kind: 'error', text: t('rowsLoadFailed') });
    }
  }

  async function onCreate() {
    if (!selectedDocId || create.isPending) return;
    setNotice(null);
    try {
      await create.mutateAsync(selectedDocId);
      setRows(null);
      setRowsState('idle');
    } catch {
      setNotice({ kind: 'error', text: t('createFailed') });
    }
  }

  async function onRunExtract() {
    if (!draft || run.isPending) return;
    setNotice(null);
    try {
      const result = await run.mutateAsync(draft.id);
      setNotice({ kind: 'ok', text: t('extractOk', { count: result.rowCount }) });
      await loadRows(draft.id);
    } catch {
      setNotice({ kind: 'error', text: t('extractFailed') });
    }
  }

  function startEdit(row: TabuExtractionReviewRow) {
    setEditingId(row.id);
    setEditDraft({
      name: row.name ?? '',
      // The masked value is shown read-only and NEVER editable/sent.
      nationalId: row.nationalId ?? '',
      shareNumerator: row.shareNumerator !== null ? String(row.shareNumerator) : '',
      shareDenominator: row.shareDenominator !== null ? String(row.shareDenominator) : '',
    });
  }

  async function onSaveRow(row: TabuExtractionReviewRow) {
    if (!draft || !editDraft || savingRow) return;
    const patch: UpdateTabuExtractionRow = {};
    const name = editDraft.name.trim();
    if (name && name !== (row.name ?? '')) patch.name = name;
    // SECURITY (review finding): a masked actor's nationalId contains '•' —
    // it must NEVER round-trip into the PATCH. The input is read-only in
    // that case AND we re-check here (defense in depth).
    if (!isMaskedNationalId(row.nationalId)) {
      const nid = editDraft.nationalId.trim();
      if (nid && nid !== (row.nationalId ?? '')) patch.nationalId = nid;
    }
    const num = Number(editDraft.shareNumerator);
    const den = Number(editDraft.shareDenominator);
    if (
      editDraft.shareNumerator !== '' &&
      Number.isInteger(num) &&
      num >= 0 &&
      num !== row.shareNumerator
    ) {
      patch.shareNumerator = num;
    }
    if (
      editDraft.shareDenominator !== '' &&
      Number.isInteger(den) &&
      den >= 1 &&
      den !== row.shareDenominator
    ) {
      patch.shareDenominator = den;
    }
    if (Object.keys(patch).length === 0) {
      setEditingId(null);
      setEditDraft(null);
      return;
    }
    setNotice(null);
    setSavingRow(true);
    try {
      await stepUp.withStepUp(() => updateTabuExtractionRow(draft.id, row.id, patch));
      await loadRows(draft.id);
    } catch (e) {
      if (!isStepUpCancelled(e)) {
        setNotice({ kind: 'error', text: t('rowSaveFailed') });
      }
    } finally {
      setSavingRow(false);
    }
  }

  async function onConfirm() {
    if (!draft || confirming) return;
    setNotice(null);
    setConfirming(true);
    try {
      await stepUp.withStepUp(() => confirmTabuExtraction(draft.id));
      setRows(null);
      setRowsState('idle');
      // Refresh the owners list on this page (useApartmentCoOwnerShares /
      // useApartmentOwners share the ['ownerships'] key family) + the
      // extraction lifecycle list.
      qc.invalidateQueries({ queryKey: ['ownerships'] });
      qc.invalidateQueries({ queryKey: ['tabu-extractions'] });
      setNotice({ kind: 'ok', text: t('confirmOk') });
    } catch (e) {
      if (isStepUpCancelled(e)) return;
      if (e instanceof ApiClientError && e.code === TABU_NOT_DRAFT_CODE) {
        // The idempotency contract — someone already confirmed. An INFO.
        qc.invalidateQueries({ queryKey: ['tabu-extractions'] });
        setNotice({ kind: 'info', text: t('alreadyConfirmed') });
        return;
      }
      setNotice({ kind: 'error', text: t('confirmFailed') });
    } finally {
      setConfirming(false);
    }
  }

  const shareTotal = rows && rows.length > 0 ? sumShares(rows) : null;
  const shareTotalLabel =
    shareTotal === null
      ? t('shareUnknown')
      : shareTotal.num === shareTotal.den
        ? t('shareFull')
        : `${shareTotal.num}/${shareTotal.den}`;

  return (
    <div className="rounded-md border bg-card p-4" data-testid="tabu-review-section">
      <h2 className="text-sm font-semibold">{t('sectionTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('sectionHint')}</p>

      {listLoading && <p className="mt-3 text-sm text-muted-foreground">{t('loading')}</p>}

      {/* Step 1 — no draft: pick a source נסח and create the extraction. */}
      {!listLoading && !draft && (
        <div className="mt-3 space-y-2">
          {docs && docs.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('noDocs')}{' '}
              <Link href="/documents/new" className="underline">
                {t('uploadDoc')}
              </Link>
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="tabu-source-doc" className="text-sm">
                {t('pickDocLabel')}
              </label>
              <select
                id="tabu-source-doc"
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={selectedDocId}
                onChange={(e) => setSelectedDocId(e.target.value)}
                disabled={create.isPending}
                data-testid="tabu-source-doc-select"
              >
                <option value="">{t('pickDocPlaceholder')}</option>
                {(docs?.items ?? [])
                  .filter((d) => !d.isArchived)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {/* <option> cannot contain <bdi> — strip bidi overrides. */}
                      {stripBidiOverrides(d.name)}
                    </option>
                  ))}
              </select>
              <Button
                size="sm"
                onClick={onCreate}
                disabled={!selectedDocId || create.isPending}
                data-testid="tabu-create-extraction"
              >
                {create.isPending ? t('creating') : t('createExtraction')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Steps 2-5 — a draft extraction exists. */}
      {!listLoading && draft && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              {t('draftBadge')}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={onRunExtract}
              disabled={run.isPending}
              aria-busy={run.isPending}
              data-testid="tabu-run-extract"
            >
              {run.isPending ? t('running') : t('runExtract')}
            </Button>
            {rowsState === 'idle' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadRows(draft.id)}
                data-testid="tabu-show-rows"
              >
                {t('showRows')}
              </Button>
            )}
          </div>

          {rowsState === 'loading' && (
            <p className="text-sm text-muted-foreground">{t('loadingRows')}</p>
          )}

          {rowsState === 'ready' && rows && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('noRows')}</p>
          )}

          {rowsState === 'ready' && rows && rows.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="tabu-review-table">
                  <thead>
                    <tr className="border-b text-start text-xs text-muted-foreground">
                      <th className="px-2 py-1.5 text-start">{t('col.name')}</th>
                      <th className="px-2 py-1.5 text-start">{t('col.nationalId')}</th>
                      <th className="px-2 py-1.5 text-start">{t('col.share')}</th>
                      <th className="px-2 py-1.5 text-start">{t('col.confidence')}</th>
                      <th className="px-2 py-1.5 text-start">{t('col.edited')}</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const masked = isMaskedNationalId(row.nationalId);
                      const isEditing = editingId === row.id && editDraft !== null;
                      return (
                        <tr key={row.id} className="border-b align-middle">
                          <td className="px-2 py-1.5">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editDraft.name}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, name: e.target.value })
                                }
                                aria-label={t('col.name')}
                                className="w-36 rounded-md border bg-background px-2 py-1"
                                data-testid="tabu-edit-name"
                              />
                            ) : (
                              <NameDisplay name={row.name ?? '—'} />
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing ? (
                              <input
                                type="text"
                                dir="ltr"
                                value={editDraft.nationalId}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, nationalId: e.target.value })
                                }
                                // SECURITY — masked actors (D.19/D.47) see
                                // '•••••••NN'; the field is READ-ONLY so the
                                // bullets can never round-trip into the PATCH.
                                readOnly={masked}
                                disabled={masked}
                                title={masked ? t('maskedIdHint') : undefined}
                                aria-label={t('col.nationalId')}
                                className="w-28 rounded-md border bg-background px-2 py-1 disabled:cursor-not-allowed disabled:opacity-60"
                                data-testid="tabu-edit-national-id"
                              />
                            ) : (
                              <span dir="ltr">{row.nationalId ?? '—'}</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing ? (
                              <span className="inline-flex items-center gap-1" dir="ltr">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={editDraft.shareNumerator}
                                  onChange={(e) =>
                                    setEditDraft({ ...editDraft, shareNumerator: e.target.value })
                                  }
                                  aria-label={t('shareNumeratorLabel')}
                                  className="w-16 rounded-md border bg-background px-2 py-1"
                                  data-testid="tabu-edit-share-num"
                                />
                                <span>/</span>
                                <input
                                  type="number"
                                  min={1}
                                  step={1}
                                  value={editDraft.shareDenominator}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      shareDenominator: e.target.value,
                                    })
                                  }
                                  aria-label={t('shareDenominatorLabel')}
                                  className="w-16 rounded-md border bg-background px-2 py-1"
                                  data-testid="tabu-edit-share-den"
                                />
                              </span>
                            ) : row.shareNumerator !== null && row.shareDenominator !== null ? (
                              <span dir="ltr">
                                {row.shareNumerator}/{row.shareDenominator}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            {row.confidence !== null
                              ? row.confidence <= 1
                                ? `${Math.round(row.confidence * 100)}%`
                                : String(row.confidence)
                              : '—'}
                          </td>
                          <td className="px-2 py-1.5">{row.edited ? t('editedYes') : '—'}</td>
                          <td className="px-2 py-1.5 text-end">
                            {isEditing ? (
                              <span className="inline-flex gap-1">
                                <Button
                                  size="sm"
                                  onClick={() => onSaveRow(row)}
                                  disabled={savingRow}
                                  data-testid="tabu-save-row"
                                >
                                  {savingRow ? t('saving') : t('save')}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setEditingId(null);
                                    setEditDraft(null);
                                  }}
                                  disabled={savingRow}
                                >
                                  {t('cancelEdit')}
                                </Button>
                              </span>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => startEdit(row)}
                                data-testid="tabu-edit-row"
                              >
                                {t('edit')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Step 5 — confirm. The summary line states EXACTLY what the
                  commit does (replace, owner count, share total). */}
              <div className="rounded-md border bg-background p-3">
                <p className="text-sm" data-testid="tabu-confirm-summary">
                  {t('confirmSummary', { count: rows.length, total: shareTotalLabel })}
                </p>
                <div className="mt-2">
                  <Button
                    size="sm"
                    onClick={onConfirm}
                    disabled={confirming}
                    aria-busy={confirming}
                    data-testid="tabu-confirm"
                  >
                    {confirming ? t('confirming') : t('confirmCta')}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {notice && (
        <p
          role="status"
          aria-live="polite"
          data-testid={`tabu-notice-${notice.kind}`}
          className="mt-3 rounded-md border px-2 py-1 text-sm"
          style={{
            color:
              notice.kind === 'ok'
                ? 'var(--success-700)'
                : notice.kind === 'info'
                  ? 'var(--warning-700)'
                  : 'var(--danger-700)',
            background: 'var(--bg-surface)',
            borderColor: 'var(--border)',
          }}
        >
          {notice.text}
        </p>
      )}

      {/* The F1 unlock modal (null while closed). */}
      {stepUp.dialog}
    </div>
  );
}
