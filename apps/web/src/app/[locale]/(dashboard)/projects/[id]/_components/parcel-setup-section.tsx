'use client';

import type { CreateParcelSetup, ParcelSetup } from '@emapp/shared-types';
import { Landmark, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useBuildingList } from '@/hooks/use-buildings';
import {
  useConfirmParcelSetup,
  useCreateParcelSetup,
  useSaveParcelSetupPayload,
} from '@/hooks/use-parcel-setups';
import { ApiClientError } from '@/lib/api/errors';
import {
  PARCEL_SETUP_NOT_DRAFT_CODE,
  PARCEL_SKELETON_CONFLICT_CODE,
} from '@/lib/api/parcel-setups';
import {
  buildParcelPayload,
  parcelSummary,
  type BuildParcelPayloadError,
  type ParcelFormRow,
} from '@/lib/parcel-payload';

/**
 * P3c — "הקמה מגוש-חלקה": parcel-setup preview/confirm screen on the project
 * dashboard tab (docs/DESIGN-phase3-parcel-autosetup.md §3/§6/§7.1-2).
 *
 * Flow:
 *  1. Action button opens the גוש/חלקה form (method="post" — GET-fallback
 *     guard) → POST /projects/:id/parcel-setups (Idempotency-Key). The
 *     create runs the provider lookup server-side; the outcome line shows
 *     'זוהה: {city}' (found) or 'לא נמצא — המשך בהזנה ידנית' (not_found).
 *  2. Builder rows — address/city (city pre-filled from providerCity when
 *     found) + the user's EXPLICIT apartments decision per building: the
 *     קומות×דירות-לקומה generator OR one-by-one apartments. With no decision
 *     the confirm button stays DISABLED (§7.1-2 — never a silent default).
 *     The strict wire payload is built EXCLUSIVELY by the pure
 *     `buildParcelPayload` seam (src/lib/parcel-payload.ts) — fresh objects,
 *     exact keys, no PII can structurally ride the public-record jsonb.
 *  3. "אישור והקמה" → PATCH /parcel-setups/:id { payload } THEN
 *     POST /parcel-setups/:id/confirm — in that order, fail-closed: a PATCH
 *     409 `parcel_setup_not_draft` shows 'כבר אושר' and confirm NEVER fires;
 *     a confirm 409 `parcel_skeleton_conflict` shows the conflict copy and
 *     does NOT refetch buildings.
 *  4. Confirm 200 → the buildings query family is invalidated (hook) AND the
 *     success panel MOUNTS the project buildings list (useBuildingList), so
 *     a fresh GET /projects/:id/buildings hits the wire — the user sees the
 *     materialized skeleton without leaving the page.
 *
 * Drafting is local: typing in the builder never writes to the wire — the
 * PATCH happens once, on confirm (e2e pins the exact call order).
 */

/** One explicit-apartment draft row (string state — inputs are controlled). */
type ApartmentDraftState = { number: string; floor: string };

/** One builder row (string state; mapped to ParcelFormRow on every render). */
type RowState = {
  address: string;
  city: string;
  number: string;
  floorsCount: string;
  genFloors: string;
  genPerFloor: string;
  apartments: ApartmentDraftState[];
};

function emptyRow(city: string): RowState {
  return {
    address: '',
    city,
    number: '',
    floorsCount: '',
    genFloors: '',
    genPerFloor: '',
    apartments: [],
  };
}

/** Numeric input → integer, or NaN when non-empty garbage (kept invalid so
 *  the seam rejects it — never silently coerced). */
function toInt(value: string): number {
  const n = Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

/**
 * Map ONE builder row's string state to the seam's ParcelFormRow. Picks
 * known keys only (never spreads state). The decision keys follow §7.1-2:
 *  - `generate` exists iff the user touched EITHER generator input (a
 *    half-filled generator is then rejected by the seam as invalid — not
 *    silently completed);
 *  - `apartments` exists iff the user added at least one explicit row.
 */
function toFormRow(row: RowState): ParcelFormRow {
  const out: ParcelFormRow = { address: row.address };
  if (row.city.trim() !== '') out.city = row.city;
  if (row.number.trim() !== '') out.number = row.number;
  if (row.floorsCount.trim() !== '') {
    const floorsCount = toInt(row.floorsCount);
    if (Number.isInteger(floorsCount)) out.floorsCount = floorsCount;
  }
  const genTouched = row.genFloors.trim() !== '' || row.genPerFloor.trim() !== '';
  if (genTouched) {
    out.generate = { floors: toInt(row.genFloors), perFloor: toInt(row.genPerFloor) };
  }
  if (row.apartments.length > 0) {
    out.apartments = row.apartments.map((apt) => {
      const floor = apt.floor.trim() === '' ? undefined : toInt(apt.floor);
      return typeof floor === 'number' && Number.isInteger(floor)
        ? { number: apt.number, floor }
        : { number: apt.number };
    });
  }
  return out;
}

type Phase = 'closed' | 'lookup' | 'builder' | 'confirmed';

const inputClass = 'w-full rounded-md border px-3 py-2 text-sm';
const labelClass = 'text-sm font-medium';

export function ParcelSetupSection({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.parcelSetup');

  const [phase, setPhase] = useState<Phase>('closed');
  const [blockNumber, setBlockNumber] = useState('');
  const [parcelNumber, setParcelNumber] = useState('');
  const [subParcel, setSubParcel] = useState('');
  const [setup, setSetup] = useState<ParcelSetup | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const create = useCreateParcelSetup(projectId);
  const save = useSaveParcelSetupPayload();
  const confirm = useConfirmParcelSetup();

  // Derived on every render — the seam IS the enablement rule (§7.1-2):
  // the confirm button is disabled until buildParcelPayload says ok.
  const result = buildParcelPayload(rows.map(toFormRow));

  async function onLookupSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (create.isPending) return;
    setMessage(null);
    // Strict CreateParcelSetupInput body — exactly these keys, subParcel
    // omitted when blank (block/parcel are PUBLIC land-registration numbers).
    const body: CreateParcelSetup = {
      blockNumber: blockNumber.trim(),
      parcelNumber: parcelNumber.trim(),
      ...(subParcel.trim() !== '' ? { subParcel: subParcel.trim() } : {}),
    };
    try {
      const created = await create.mutateAsync(body);
      setSetup(created);
      // Row 0 city pre-filled from the provider hit; blank on not_found.
      setRows([emptyRow(created.providerCity ?? '')]);
      setPhase('builder');
    } catch {
      setMessage({ kind: 'error', text: t('createFailed') });
    }
  }

  function patchRow(index: number, patch: Partial<RowState>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function patchApartment(rowIndex: number, aptIndex: number, patch: Partial<ApartmentDraftState>) {
    setRows((prev) =>
      prev.map((row, i) =>
        i === rowIndex
          ? {
              ...row,
              apartments: row.apartments.map((apt, j) =>
                j === aptIndex ? { ...apt, ...patch } : apt,
              ),
            }
          : row,
      ),
    );
  }

  async function onConfirm() {
    if (!setup || !result.ok || save.isPending || confirm.isPending) return;
    setMessage(null);
    // 1) PATCH the strict payload. Fail-closed: any failure stops the chain
    //    — the confirm POST never fires on a failed save.
    try {
      await save.mutateAsync({ id: setup.id, payload: result.payload });
    } catch (e) {
      const notDraft = e instanceof ApiClientError && e.code === PARCEL_SETUP_NOT_DRAFT_CODE;
      setMessage({ kind: 'error', text: notDraft ? t('alreadyConfirmed') : t('saveFailed') });
      return;
    }
    // 2) POST confirm — the atomic skeleton materialization.
    try {
      const confirmed = await confirm.mutateAsync(setup.id);
      setSetup(confirmed);
      setPhase('confirmed');
      setMessage({ kind: 'ok', text: t('confirmedOk') });
    } catch (e) {
      const conflict = e instanceof ApiClientError && e.code === PARCEL_SKELETON_CONFLICT_CODE;
      setMessage({ kind: 'error', text: conflict ? t('skeletonConflict') : t('confirmFailed') });
    }
  }

  const isConfirming = save.isPending || confirm.isPending;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="parcel-setup-h">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="parcel-setup-h" className="flex items-center gap-1.5 text-sm font-semibold">
          <Landmark className="h-4 w-4" aria-hidden="true" />
          {t('title')}
        </h2>
        {phase === 'closed' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm ms-auto"
            onClick={() => setPhase('lookup')}
          >
            {t('action')}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
        {t('hint')}
      </p>

      {phase === 'lookup' && (
        // §S1-SEC1 — explicit method="post": if JS hasn't hydrated, the
        // native fallback must never put the form fields in a GET URL.
        <form method="post" action="" onSubmit={onLookupSubmit} className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor="blockNumber" className={labelClass}>
                {t('blockLabel')}
              </label>
              <input
                id="blockNumber"
                type="text"
                className={inputClass}
                value={blockNumber}
                onChange={(e) => setBlockNumber(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="parcelNumber" className={labelClass}>
                {t('parcelLabel')}
              </label>
              <input
                id="parcelNumber"
                type="text"
                className={inputClass}
                value={parcelNumber}
                onChange={(e) => setParcelNumber(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="subParcel" className={labelClass}>
                {t('subParcelLabel')}
              </label>
              <input
                id="subParcel"
                type="text"
                className={inputClass}
                value={subParcel}
                onChange={(e) => setSubParcel(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center justify-end">
            <button
              type="submit"
              className="btn btn-primary btn-sm disabled:cursor-not-allowed disabled:opacity-60"
              disabled={create.isPending || blockNumber.trim() === '' || parcelNumber.trim() === ''}
              aria-busy={create.isPending}
            >
              {create.isPending ? t('looking') : t('lookup')}
            </button>
          </div>
        </form>
      )}

      {phase === 'builder' && setup && (
        <div className="mt-3 space-y-4">
          {/* Provider lookup outcome (P3b) — found / manual fallback. */}
          <p role="status" aria-live="polite" className="text-sm font-medium">
            {setup.providerStatus === 'found' && setup.providerCity
              ? t('detected', { city: setup.providerCity })
              : t('notFoundManual')}
          </p>

          {rows.map((row, i) => (
            <fieldset key={i} className="space-y-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-semibold">
                {t('buildingTitle', { num: i + 1 })}
              </legend>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`b${i}-address`} className={labelClass}>
                    {t('addressLabel')}
                  </label>
                  <input
                    id={`b${i}-address`}
                    type="text"
                    className={inputClass}
                    value={row.address}
                    onChange={(e) => patchRow(i, { address: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`b${i}-city`} className={labelClass}>
                    {t('cityLabel')}
                  </label>
                  <input
                    id={`b${i}-city`}
                    type="text"
                    className={inputClass}
                    value={row.city}
                    onChange={(e) => patchRow(i, { city: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`b${i}-number`} className={labelClass}>
                    {t('buildingNumberLabel')}
                  </label>
                  <input
                    id={`b${i}-number`}
                    type="text"
                    className={inputClass}
                    value={row.number}
                    onChange={(e) => patchRow(i, { number: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`b${i}-floorsCount`} className={labelClass}>
                    {t('floorsCountLabel')}
                  </label>
                  <input
                    id={`b${i}-floorsCount`}
                    type="number"
                    min={0}
                    step={1}
                    className={inputClass}
                    value={row.floorsCount}
                    onChange={(e) => patchRow(i, { floorsCount: e.target.value })}
                  />
                </div>
              </div>

              {/* §7.1-2 decision A — the קומות×דירות-לקומה generator. */}
              <div className="space-y-1">
                <p className={labelClass}>{t('genLegend')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label
                      htmlFor={`b${i}-gen-floors`}
                      className="text-xs"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {t('genFloorsLabel')}
                    </label>
                    <input
                      id={`b${i}-gen-floors`}
                      type="number"
                      min={1}
                      step={1}
                      className={inputClass}
                      value={row.genFloors}
                      onChange={(e) => patchRow(i, { genFloors: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor={`b${i}-gen-perFloor`}
                      className="text-xs"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {t('genPerFloorLabel')}
                    </label>
                    <input
                      id={`b${i}-gen-perFloor`}
                      type="number"
                      min={1}
                      step={1}
                      className={inputClass}
                      value={row.genPerFloor}
                      onChange={(e) => patchRow(i, { genPerFloor: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              {/* §7.1-2 decision B — explicit one-by-one apartments. */}
              {row.apartments.length > 0 && (
                <div className="space-y-2">
                  <p className={labelClass}>{t('aptsLegend')}</p>
                  {row.apartments.map((apt, j) => (
                    <div key={j} className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <label
                          htmlFor={`b${i}-apt${j}-number`}
                          className="text-xs"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {t('aptNumberLabel')}
                        </label>
                        <input
                          id={`b${i}-apt${j}-number`}
                          type="text"
                          className={inputClass}
                          value={apt.number}
                          onChange={(e) => patchApartment(i, j, { number: e.target.value })}
                        />
                      </div>
                      <div className="flex-1 space-y-1">
                        <label
                          htmlFor={`b${i}-apt${j}-floor`}
                          className="text-xs"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {t('aptFloorLabel')}
                        </label>
                        <input
                          id={`b${i}-apt${j}-floor`}
                          type="number"
                          step={1}
                          className={inputClass}
                          value={apt.floor}
                          onChange={(e) => patchApartment(i, j, { floor: e.target.value })}
                        />
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-label={t('removeApartment')}
                        onClick={() =>
                          patchRow(i, { apartments: row.apartments.filter((_, k) => k !== j) })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    patchRow(i, { apartments: [...row.apartments, { number: '', floor: '' }] })
                  }
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('addApartment')}
                </button>
                {rows.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm ms-auto"
                    onClick={() => setRows((prev) => prev.filter((_, k) => k !== i))}
                  >
                    {t('removeBuilding')}
                  </button>
                )}
              </div>
            </fieldset>
          ))}

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setRows((prev) => [...prev, emptyRow(setup.providerCity ?? '')])}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('addBuilding')}
          </button>

          {/* Summary — the pinned parcelSummary phrasing (the seam is the
           *  single source; the e2e asserts the same string). Rendered only
           *  when the payload is buildable. */}
          {result.ok ? (
            <p className="text-sm font-medium" style={{ color: 'var(--success-700)' }}>
              {parcelSummary(result.payload)}
            </p>
          ) : (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {firstErrorHint(result.errors, t)}
            </p>
          )}

          <div className="flex items-center justify-end">
            {/* §7.1-2 — disabled until the seam says ok: no silent default
             *  can ever stand in for the user's apartments decision. */}
            <button
              type="button"
              className="btn btn-primary btn-sm disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!result.ok || isConfirming}
              aria-busy={isConfirming}
              onClick={onConfirm}
            >
              {isConfirming ? t('confirming') : t('confirm')}
            </button>
          </div>
        </div>
      )}

      {phase === 'confirmed' && (
        // Mounting the buildings list here is what makes the fresh
        // GET /projects/:id/buildings hit the wire after the confirm 200 —
        // the user sees the materialized skeleton without leaving the page.
        <ConfirmedBuildings projectId={projectId} />
      )}

      {message && (
        <p
          role="status"
          aria-live="polite"
          className="mt-2 text-sm"
          style={{ color: message.kind === 'ok' ? 'var(--success-700)' : 'var(--danger-700)' }}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

/** Localized hint for the FIRST builder validation error (muted guidance —
 *  the disabled confirm button is the actual §7.1-2 enforcement). */
function firstErrorHint(
  errors: Array<{ index: number; code: BuildParcelPayloadError }>,
  t: (key: string) => string,
): string {
  const code = errors[0]?.code;
  switch (code) {
    case 'no_rows':
      return t('errNoRows');
    case 'address_required':
      return t('errAddressRequired');
    case 'no_apartments_decision':
      return t('errNoDecision');
    case 'ambiguous_apartments':
      return t('errAmbiguous');
    case 'invalid_generator':
      return t('errInvalidGenerator');
    case 'too_many_apartments':
      return t('errTooMany');
    case 'empty_apartments':
      return t('errEmptyApartments');
    case 'apartment_number_required':
      return t('errAptNumberRequired');
    default:
      return t('errNoDecision');
  }
}

/** Post-confirm panel — mounts the project buildings query so the freshly
 *  materialized skeleton is fetched and shown in place. */
function ConfirmedBuildings({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.parcelSetup');
  const { data, isLoading } = useBuildingList(projectId);
  return (
    <div className="mt-3 space-y-2">
      {isLoading ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {t('loadingBuildings')}
        </p>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {t('buildingsNow', { count: data?.items.length ?? 0 })}
        </p>
      )}
    </div>
  );
}
