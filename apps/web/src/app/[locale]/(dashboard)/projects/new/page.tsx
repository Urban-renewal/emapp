'use client';

import {
  CreateProjectInput,
  type CreateProject,
  type ProjectType,
  type SectionKind,
} from '@emapp/shared-types';
import { ArrowLeft, ArrowRight, Building2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useCreateProject } from '@/hooks/use-projects';
import { ApiClientError } from '@/lib/api/errors';

/**
 * V11 A.S6 — AddProject 3-step wizard per
 * `MEAPP_design/screens-add-project.jsx`.
 *
 * Step 1 (Details): project name + type + description.
 * Step 2 (Structure): zero-or-more buildings, each with address + city
 *   + block/parcel + ONE section (kind + floors + unitCount).
 *   Multi-section per building (entrances) is deferred to a polish
 *   slice; the BE wire (D.39 / B.S2) accepts up to 20 sections/building
 *   but the wizard ships single-section to keep MVP UX small.
 * Step 3 (Review): summary panel + Create button. POST to
 *   `/api/v1/projects` with the full nested shape if buildings ≥ 1,
 *   or the back-compat simple shape if no buildings — both validated
 *   against `CreateProjectInput` from shared-types.
 *
 * Why plain useState + manual validation (no react-hook-form +
 * useFieldArray): the wizard's per-step validation is shaped by the
 * 3-step flow more than by per-field bindings, and `useFieldArray`
 * adds complexity that the simple list-of-buildings doesn't earn.
 * The `CreateProjectInput.safeParse` boundary check on submit is the
 * authoritative validation; per-step UI checks are progressive
 * disclosure only.
 */

const PROJECT_TYPES: ReadonlyArray<ProjectType> = ['tama38_1', 'tama38_2', 'pinui_binui'];
const SECTION_KINDS: ReadonlyArray<SectionKind> = ['residential', 'office', 'retail', 'mixed'];

interface WizardBuilding {
  // Local-only id for React keys; not sent to BE.
  rid: string;
  address: string;
  city: string;
  block: string;
  parcel: string;
  sectionKind: SectionKind;
  sectionFloors: string;
  sectionUnitCount: string;
}

interface WizardState {
  step: 1 | 2 | 3;
  name: string;
  type: ProjectType;
  description: string;
  buildings: WizardBuilding[];
}

function newBuilding(): WizardBuilding {
  return {
    rid: Math.random().toString(36).slice(2, 10),
    address: '',
    city: '',
    block: '',
    parcel: '',
    sectionKind: 'residential',
    sectionFloors: '',
    sectionUnitCount: '',
  };
}

/** Map wizard state → CreateProjectInput shape. Strips empty strings to
 *  undefined so the BE `.strict()` validation doesn't see noise. */
function toCreateInput(s: WizardState): CreateProject {
  const base: CreateProject = {
    name: s.name.trim(),
    type: s.type,
    description: s.description.trim() || undefined,
  };
  const buildings = s.buildings
    .filter((b) => b.address.trim() && b.city.trim())
    .map((b) => ({
      address: b.address.trim(),
      city: b.city.trim(),
      block: b.block.trim() || undefined,
      parcel: b.parcel.trim() || undefined,
      sections: [
        {
          kind: b.sectionKind,
          floors: b.sectionFloors ? Number(b.sectionFloors) : undefined,
          unitCount: b.sectionUnitCount ? Number(b.sectionUnitCount) : undefined,
        },
      ],
    }));
  return buildings.length ? { ...base, buildings } : base;
}

export default function NewProjectPage() {
  const t = useTranslations('projects');
  const tw = useTranslations('projects.wizard');
  const tt = useTranslations('projects.types');
  const tk = useTranslations('projects.wizard.section');
  const router = useRouter();
  const mutation = useCreateProject();

  const [state, setState] = useState<WizardState>({
    step: 1,
    name: '',
    type: 'tama38_2',
    description: '',
    buildings: [],
  });
  const [stepError, setStepError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // §FUNC-4 — hydration gate. This is a client-only controlled-input
  // wizard: the SSR HTML paints before React attaches the input
  // onChange + button onClick handlers. A user (or a fast test) who
  // fills fields and clicks "next"/"create" during that window gets a
  // partial/no-op submit — the typed values never reached React state,
  // so canAdvanceFromStep1 sees an empty name and the wizard silently
  // stays on step 1 (or worse, a half-built state POSTs). On a slow
  // connection this window is real and user-visible. We close it by
  // gating every nav/submit control on a real hydration signal: the
  // effect runs only after hydration, flipping `hydrated` true, which
  // (a) enables Back/Next/Create and (b) sets data-hydrated="true" on
  // the form so callers have a deterministic readiness signal instead
  // of a timing guess.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  // Synchronous in-flight guard — useRef value is updated immediately
  // (no render-cycle latency), so a second submit that arrives before
  // React re-renders `mutation.isPending` still sees the flag and bails.
  // j2 e2e caught a 2-POST regression without this; the ref closes
  // that race.
  const submitInFlightRef = useRef(false);

  function canAdvanceFromStep1(): true | string {
    if (!state.name.trim()) return tw('validation.nameRequired');
    return true;
  }
  function canAdvanceFromStep2(): true | string {
    for (const b of state.buildings) {
      if (!b.address.trim()) return tw('validation.buildingAddressRequired');
      if (!b.city.trim()) return tw('validation.buildingCityRequired');
    }
    return true;
  }

  function onNext() {
    // Defense in depth: the button is disabled until hydrated, but a
    // stray Enter keypress or programmatic click could still reach
    // here pre-hydration with empty state — bail rather than emit a
    // spurious validation error.
    if (!hydrated) return;
    setStepError(null);
    const check = state.step === 1 ? canAdvanceFromStep1() : canAdvanceFromStep2();
    if (check !== true) {
      setStepError(check);
      return;
    }
    setState((s) => ({ ...s, step: (s.step + 1) as 2 | 3 }));
  }

  function onBack() {
    setStepError(null);
    setState((s) => ({ ...s, step: Math.max(1, s.step - 1) as 1 | 2 | 3 }));
  }

  async function onSubmit() {
    // Two guards against double-fire (j2 e2e caught a 2-POST regression):
    //  1. `submitInFlightRef` — synchronous ref check; closes the
    //     React-render-latency race where `mutation.isPending` hasn't
    //     flipped to true yet before a second call lands.
    //  2. `state.step !== 3` — defensive: the Create button only
    //     renders at step 3, but if any earlier click bubbles to the
    //     form's onSubmit (shadcn Button quirk, stray keyboard Enter
    //     on an input, etc.), we must not POST.
    //  3. `!hydrated` — never POST before React has attached its
    //     handlers; the field values would not yet be in state.
    if (submitInFlightRef.current || state.step !== 3 || !hydrated) return;
    submitInFlightRef.current = true;
    setServerError(null);
    setStepError(null);
    const candidate = toCreateInput(state);
    const parsed = CreateProjectInput.safeParse(candidate);
    if (!parsed.success) {
      setServerError(t('createFailed'));
      submitInFlightRef.current = false;
      return;
    }
    try {
      const project = await mutation.mutateAsync(parsed.data);
      router.push(`/projects/${project.id}`);
      // Intentionally NOT releasing the ref on success — the component
      // is about to unmount via router.push; releasing would allow a
      // late re-render to double-POST during the navigation window.
    } catch (e) {
      // Anti-enumeration generic — same UX whether server-side validation
      // failed, RBAC failed, or network failed.
      if (e instanceof ApiClientError) setServerError(t('createFailed'));
      else setServerError(t('createFailed'));
      submitInFlightRef.current = false;
    }
  }

  function patchBuilding(rid: string, patch: Partial<WizardBuilding>) {
    setState((s) => ({
      ...s,
      buildings: s.buildings.map((b) => (b.rid === rid ? { ...b, ...patch } : b)),
    }));
  }
  function addBuilding() {
    setState((s) => ({ ...s, buildings: [...s.buildings, newBuilding()] }));
  }
  function removeBuilding(rid: string) {
    setState((s) => ({ ...s, buildings: s.buildings.filter((b) => b.rid !== rid) }));
  }

  function kindLabel(k: SectionKind): string {
    return k === 'residential'
      ? tk('kindResidential')
      : k === 'office'
        ? tk('kindOffice')
        : k === 'retail'
          ? tk('kindRetail')
          : tk('kindMixed');
  }

  return (
    // §S5-SEC1 — method="post" + action="" + handleSubmit-equivalent
    // wrapper around the wizard. Submission only fires when the
    // step-3 "Create" button (type="submit") is clicked; Next/Back
    // buttons are type="button" and don't trigger this handler.
    // The defense-in-depth contract from PR #47/#61 applies even
    // though the wizard is multi-step UX-wise.
    <form
      method="post"
      action=""
      data-hydrated={hydrated ? 'true' : 'false'}
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit();
      }}
      className="mx-auto flex max-w-2xl flex-col gap-4"
    >
      {/* Stepper indicator */}
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('create')}
        </h1>
        <ol className="flex items-center gap-2" aria-label={t('create')}>
          {[1, 2, 3].map((n) => {
            const active = state.step === n;
            const done = state.step > n;
            return (
              <li key={n} className="flex items-center gap-2">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold"
                  style={{
                    background: active || done ? 'var(--navy-900)' : 'var(--bg-subtle)',
                    color: active || done ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${active || done ? 'var(--navy-900)' : 'var(--border-strong)'}`,
                  }}
                  aria-current={active ? 'step' : undefined}
                >
                  {n}
                </div>
                <span
                  className="text-xs"
                  style={{
                    color: active ? 'var(--text)' : 'var(--text-muted)',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {n === 1 ? tw('step1') : n === 2 ? tw('step2') : tw('step3')}
                </span>
                {n < 3 && (
                  <span
                    aria-hidden="true"
                    className="block"
                    style={{ width: 24, height: 1, background: 'var(--border)' }}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Step content */}
      <div className="card card-pad flex flex-col gap-4">
        {state.step === 1 && (
          <>
            <div>
              <label htmlFor="name" className="label">
                {t('field.name')}
              </label>
              <input
                id="name"
                type="text"
                className="input"
                value={state.name}
                onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
                autoComplete="off"
                required
              />
            </div>

            <div>
              <label htmlFor="type" className="label">
                {t('field.type')}
              </label>
              <select
                id="type"
                className="input"
                value={state.type}
                onChange={(e) => setState((s) => ({ ...s, type: e.target.value as ProjectType }))}
              >
                {PROJECT_TYPES.map((pt) => (
                  <option key={pt} value={pt}>
                    {tt(pt)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="description" className="label">
                {t('field.description')}
              </label>
              <textarea
                id="description"
                rows={3}
                className="input"
                style={{ height: 'auto', minHeight: 80, paddingTop: 8, paddingBottom: 8 }}
                value={state.description}
                onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
              />
            </div>
          </>
        )}

        {state.step === 2 && (
          <>
            {state.buildings.length === 0 && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {tw('noBuildings')}
              </p>
            )}
            {state.buildings.map((b, idx) => (
              <fieldset
                key={b.rid}
                className="rounded-md border p-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <legend className="px-1 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  {tw('buildingNumberLabel', { n: idx + 1 })}
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`b-${b.rid}-address`}>
                      {tw('field.address')}
                    </label>
                    <input
                      id={`b-${b.rid}-address`}
                      type="text"
                      className="input"
                      value={b.address}
                      onChange={(e) => patchBuilding(b.rid, { address: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`b-${b.rid}-city`}>
                      {tw('field.city')}
                    </label>
                    <input
                      id={`b-${b.rid}-city`}
                      type="text"
                      className="input"
                      value={b.city}
                      onChange={(e) => patchBuilding(b.rid, { city: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`b-${b.rid}-block`}>
                      {tw('field.block')}
                    </label>
                    <input
                      id={`b-${b.rid}-block`}
                      type="text"
                      className="input tabular"
                      dir="ltr"
                      value={b.block}
                      onChange={(e) => patchBuilding(b.rid, { block: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`b-${b.rid}-parcel`}>
                      {tw('field.parcel')}
                    </label>
                    <input
                      id={`b-${b.rid}-parcel`}
                      type="text"
                      className="input tabular"
                      dir="ltr"
                      value={b.parcel}
                      onChange={(e) => patchBuilding(b.rid, { parcel: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`b-${b.rid}-kind`}>
                      {tw('section.kind')}
                    </label>
                    <select
                      id={`b-${b.rid}-kind`}
                      className="input"
                      value={b.sectionKind}
                      onChange={(e) =>
                        patchBuilding(b.rid, { sectionKind: e.target.value as SectionKind })
                      }
                    >
                      {SECTION_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kindLabel(kind)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label" htmlFor={`b-${b.rid}-floors`}>
                        {tw('field.floors')}
                      </label>
                      <input
                        id={`b-${b.rid}-floors`}
                        type="number"
                        min={0}
                        max={200}
                        className="input tabular"
                        dir="ltr"
                        value={b.sectionFloors}
                        onChange={(e) => patchBuilding(b.rid, { sectionFloors: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor={`b-${b.rid}-units`}>
                        {tw('field.unitCount')}
                      </label>
                      <input
                        id={`b-${b.rid}-units`}
                        type="number"
                        min={0}
                        max={2000}
                        className="input tabular"
                        dir="ltr"
                        value={b.sectionUnitCount}
                        onChange={(e) => patchBuilding(b.rid, { sectionUnitCount: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => removeBuilding(b.rid)}
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--danger-700)' }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{tw('removeBuilding')}</span>
                  </button>
                </div>
              </fieldset>
            ))}
            <div>
              <button type="button" onClick={addBuilding} className="btn btn-secondary">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>{tw('addBuilding')}</span>
              </button>
            </div>
          </>
        )}

        {state.step === 3 && (
          <>
            <section aria-labelledby="rev-proj-h">
              <h2 id="rev-proj-h" className="text-sm font-semibold">
                {tw('review.projectHeading')}
              </h2>
              <dl className="mt-2 grid grid-cols-[120px_1fr] gap-y-1 text-sm">
                <dt style={{ color: 'var(--text-muted)' }}>{t('field.name')}</dt>
                <dd>{state.name}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>{t('field.type')}</dt>
                <dd>{tt(state.type)}</dd>
                {state.description && (
                  <>
                    <dt style={{ color: 'var(--text-muted)' }}>{t('field.description')}</dt>
                    <dd className="whitespace-pre-wrap">{state.description}</dd>
                  </>
                )}
              </dl>
            </section>

            <section
              aria-labelledby="rev-bld-h"
              className="border-t pt-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <h2 id="rev-bld-h" className="text-sm font-semibold">
                {tw('review.buildingsHeading', { n: state.buildings.length })}
              </h2>
              {state.buildings.length === 0 ? (
                <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {tw('review.noBuildings')}
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {state.buildings.map((b, idx) => (
                    <li
                      key={b.rid}
                      className="rounded-md border p-3 text-sm"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        <Building2
                          className="h-4 w-4"
                          style={{ color: 'var(--navy-700)' }}
                          aria-hidden="true"
                        />
                        <span>{tw('buildingNumberLabel', { n: idx + 1 })}</span>
                      </div>
                      <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        {[b.address, b.city].filter(Boolean).join(', ')}
                        {b.block || b.parcel
                          ? ` · ${tw('field.block')} ${b.block || '—'} / ${tw('field.parcel')} ${b.parcel || '—'}`
                          : ''}
                        {' · '}
                        {kindLabel(b.sectionKind)}
                        {b.sectionFloors ? ` · ${tw('field.floors')} ${b.sectionFloors}` : ''}
                        {b.sectionUnitCount
                          ? ` · ${tw('field.unitCount')} ${b.sectionUnitCount}`
                          : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {stepError && (
          <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
            {stepError}
          </p>
        )}
        {serverError && (
          <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
            {serverError}
          </p>
        )}
      </div>

      {/* Footer nav */}
      <div className="flex items-center justify-between gap-2">
        <div>
          {state.step > 1 && (
            <Button
              type="button"
              variant="ghost"
              onClick={onBack}
              disabled={!hydrated || mutation.isPending}
            >
              <ArrowRight className="h-4 w-4 rotate-180" aria-hidden="true" />
              <span>{tw('back')}</span>
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push('/projects')}>
            {t('cancel')}
          </Button>
          {state.step < 3 ? (
            <Button type="button" onClick={onNext} disabled={!hydrated}>
              <span>{tw('next')}</span>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : (
            <Button type="submit" disabled={!hydrated || mutation.isPending}>
              {mutation.isPending ? t('creating') : tw('submit')}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
