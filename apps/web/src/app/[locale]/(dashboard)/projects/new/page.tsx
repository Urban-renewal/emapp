'use client';

import {
  CreateProjectInput,
  PROJECT_TYPE_DEFAULT_CONSENT_PCT,
  type ApartmentUnitType,
  type CreateProject,
  type ProjectType,
  type RelocationType,
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
 *   + block/parcel + ONE-OR-MORE sections. Each section carries a `kind`
 *   (residential | office | retail | mixed) that drives progressive
 *   disclosure of the section's fields (Phase 1, owner point 2):
 *     - residential → rooms/floors-oriented;
 *     - office/retail → AREA-oriented (שטח, not rooms) — conveyed via the
 *       per-kind hint copy only; the area INPUT was removed (e2 wave-4 c5 /
 *       N16) because the wire shape has no area column to persist it;
 *     - retail → single-floor-friendly (floors de-emphasised).
 *   Multi-section per building (D.39 / B.S2 accepts up to 20) is now
 *   supported so a real mixed-use building (retail ground floor +
 *   residential above) can be modelled as ≥2 sections of different kinds.
 *   Each section's `kind` derives an intended apartment `unitType`
 *   (SECTION_KIND_DEFAULT_UNIT_TYPE) so the BE empty-apartment expansion
 *   can pre-tag units; the section wire shape itself carries no unitType
 *   column today — see TODO(gate-6) in toCreateInput.
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

const PROJECT_TYPES: ReadonlyArray<ProjectType> = ['tama38_1', 'tama38_2', 'pinui_binui', 'other'];
const SECTION_KINDS: ReadonlyArray<SectionKind> = ['residential', 'office', 'retail', 'mixed'];
const RELOCATION_TYPES: ReadonlyArray<RelocationType> = ['none', 'rent_comp', 'alt_housing'];

/**
 * Demolish-rebuild tracks where residents vacate during construction, so the
 * relocation (פינוי) arrangement is relevant. Strengthening (tama38_1) keeps
 * residents in place → relocation field is hidden. 'other' is unknown → shown
 * (forward-compat: a future demolish-rebuild successor track may need it).
 */
function isRelocationRelevant(type: ProjectType): boolean {
  return type === 'tama38_2' || type === 'pinui_binui' || type === 'other';
}

/**
 * Type-aware structure rules (FE-only progressive disclosure; the BE contract
 * `CreateProjectInput.buildings[]` is unchanged — it accepts up to 20 either
 * way). The urban-renewal track dictates the building topology:
 *  - tama38_1 (חיזוק / strengthen existing): exactly ONE building, owners stay.
 *  - tama38_2 (הריסה ובנייה / demolish-rebuild): one or two buildings.
 *  - pinui_binui (evacuation-rebuild complex / מתחם): MANY buildings.
 * The cap below is the FE max the wizard lets the user add for a given type.
 */
const MAX_BUILDINGS_BY_TYPE: Record<ProjectType, number> = {
  tama38_1: 1,
  tama38_2: 2,
  pinui_binui: 20,
  // 'other' is a forward-compat track of unknown topology — allow the full cap.
  other: 20,
};

/** BE contract cap — `CreateProjectBuildingInput.sections` is `.max(20)`. */
const MAX_SECTIONS_PER_BUILDING = 20;

/**
 * D.39 — derive the intended apartment `unit_type` from a section's `kind`,
 * so the BE empty-apartment expansion can pre-tag the units it creates for
 * the section. residential→apt, office→office, retail→shop, mixed→mixed.
 * NOTE: the section WIRE shape (`CreateProjectSectionInput`) has no unitType
 * column today, so this derivation can only ride along once that exists —
 * see TODO(gate-6) in toCreateInput. It still drives UI labels now.
 */
const SECTION_KIND_DEFAULT_UNIT_TYPE: Record<SectionKind, ApartmentUnitType> = {
  residential: 'apt',
  office: 'office',
  retail: 'shop',
  mixed: 'mixed',
};

interface WizardMilestone {
  // Local-only id for React keys; not sent to BE.
  mid: string;
  // Controlled strings so empty fields are representable; coerced on submit.
  pct: string;
  label: string;
}

function newMilestone(pct = ''): WizardMilestone {
  return { mid: Math.random().toString(36).slice(2, 10), pct, label: '' };
}

/** BE contract cap — `SignatureMilestonesSchema` is `.max(10)`. */
const MAX_MILESTONES = 10;

interface WizardSection {
  // Local-only id for React keys; not sent to BE.
  sid: string;
  kind: SectionKind;
  entrance: string;
  floors: string;
  unitCount: string;
  // N16 (e2 wave-4 c5): a per-section `areaSqm` input was removed here. The
  // wire shape `CreateProjectSectionInput` has NO area column (it is `.strict()`
  // — see packages/shared-types/src/project.ts), so anything typed was silently
  // dropped in toCreateInput. Collecting data we discard is a data-integrity +
  // honesty problem; persisting it needs a schema change (out of scope, no
  // migration). When a section-level area column lands (Gate-6), re-add the
  // input AND wire it through toCreateInput in the same slice.
}

interface WizardBuilding {
  // Local-only id for React keys; not sent to BE.
  rid: string;
  address: string;
  city: string;
  block: string;
  parcel: string;
  sections: WizardSection[];
}

interface WizardState {
  step: 1 | 2 | 3;
  name: string;
  type: ProjectType;
  description: string;
  // Owner-consent target (%) as a controlled string so the empty field is
  // representable. Pre-filled from PROJECT_TYPE_DEFAULT_CONSENT_PCT on type
  // change UNLESS the manager has manually edited it (consentTouched).
  consentPct: string;
  consentTouched: boolean;
  // Owner-approved staged overlay (Gate-6, Option A): ordered intermediate
  // signature targets under the legal consent gate.
  milestones: WizardMilestone[];
  // P3 create-form enrichment (migration 0062). All optional; controlled
  // strings so empty fields are representable and coerced/stripped on submit.
  typeLabel: string;
  developerName: string;
  developerCompanyId: string;
  existingUnits: string;
  plannedUnits: string;
  extraAreaSqm: string;
  relocationType: '' | RelocationType;
  relocationNotes: string;
  block: string;
  parcel: string;
  subparcel: string;
  buildings: WizardBuilding[];
}

function newSection(kind: SectionKind = 'residential'): WizardSection {
  return {
    sid: Math.random().toString(36).slice(2, 10),
    kind,
    entrance: '',
    floors: '',
    unitCount: '',
  };
}

function newBuilding(): WizardBuilding {
  return {
    rid: Math.random().toString(36).slice(2, 10),
    address: '',
    city: '',
    block: '',
    parcel: '',
    sections: [newSection()],
  };
}

/** Map wizard state → CreateProjectInput shape. Strips empty strings to
 *  undefined so the BE `.strict()` validation doesn't see noise. */
function toCreateInput(s: WizardState): CreateProject {
  // Empty → undefined so the BE applies the per-type default
  // (PROJECT_TYPE_DEFAULT_CONSENT_PCT); a typed value is an explicit override.
  const consent = s.consentPct.trim();
  const consentNum = consent === '' ? undefined : Number(consent);
  // Milestones: keep only rows with a real positive integer pct, coerce, and
  // sort ascending. Empty rows are dropped (a half-filled row is UI noise, not
  // an intended target). The authoritative ascending/unique/<=target check is
  // the CreateProjectInput.safeParse boundary on submit.
  const milestones = s.milestones
    .map((m) => ({ pct: Number(m.pct), label: m.label.trim() }))
    .filter((m) => Number.isInteger(m.pct) && m.pct > 0)
    .sort((a, b) => a.pct - b.pct)
    .map((m) => (m.label ? { pct: m.pct, label: m.label } : { pct: m.pct }));
  // P3 enrichment (migration 0062). Empty strings → undefined so the BE
  // `.strict()` validation sees no noise; numbers coerced only when finite.
  // relocationType rides along ONLY for demolish-rebuild tracks (residents
  // vacate); strengthening keeps residents in place so the field is dropped.
  const intOrUndef = (v: string): number | undefined => {
    const t2 = v.trim();
    if (t2 === '') return undefined;
    const n = Number(t2);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const numOrUndef = (v: string): number | undefined => {
    const t2 = v.trim();
    if (t2 === '') return undefined;
    const n = Number(t2);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const base: CreateProject = {
    name: s.name.trim(),
    type: s.type,
    description: s.description.trim() || undefined,
    targetSignaturePct:
      consentNum !== undefined && Number.isFinite(consentNum) ? consentNum : undefined,
    ...(milestones.length ? { signatureMilestones: milestones } : {}),
    // type_label only meaningful for the 'other' future track.
    ...(s.type === 'other' && s.typeLabel.trim() ? { typeLabel: s.typeLabel.trim() } : {}),
    ...(s.developerName.trim() ? { developerName: s.developerName.trim() } : {}),
    ...(s.developerCompanyId.trim() ? { developerCompanyId: s.developerCompanyId.trim() } : {}),
    ...(intOrUndef(s.existingUnits) !== undefined
      ? { existingUnits: intOrUndef(s.existingUnits) }
      : {}),
    ...(intOrUndef(s.plannedUnits) !== undefined
      ? { plannedUnits: intOrUndef(s.plannedUnits) }
      : {}),
    ...(numOrUndef(s.extraAreaSqm) !== undefined
      ? { extraAreaSqm: numOrUndef(s.extraAreaSqm) }
      : {}),
    ...(isRelocationRelevant(s.type) && s.relocationType !== ''
      ? { relocationType: s.relocationType }
      : {}),
    ...(isRelocationRelevant(s.type) && s.relocationNotes.trim()
      ? { relocationNotes: s.relocationNotes.trim() }
      : {}),
    ...(s.block.trim() ? { block: s.block.trim() } : {}),
    ...(s.parcel.trim() ? { parcel: s.parcel.trim() } : {}),
    ...(s.subparcel.trim() ? { subparcel: s.subparcel.trim() } : {}),
  };
  const buildings = s.buildings
    .filter((b) => b.address.trim() && b.city.trim())
    .map((b) => ({
      address: b.address.trim(),
      city: b.city.trim(),
      block: b.block.trim() || undefined,
      parcel: b.parcel.trim() || undefined,
      sections: b.sections.map((sec) => ({
        kind: sec.kind,
        entrance: sec.entrance.trim() || undefined,
        floors: sec.floors ? Number(sec.floors) : undefined,
        unitCount: sec.unitCount ? Number(sec.unitCount) : undefined,
        // TODO(gate-6): SECTION_KIND_DEFAULT_UNIT_TYPE[sec.kind] is the
        // intended per-section apartment unit_type for the BE empty-apartment
        // expansion. It has no column on `CreateProjectSectionInput` today —
        // adding it is a contract/schema change (Gate-6), so we drop it on the
        // wire and only drive the UI/labels from the kind for now. (A
        // sibling per-section `areaSqm` input was REMOVED in e2 wave-4 c5 / N16
        // rather than collected-then-dropped — re-add it WITH its wire column.)
      })),
    }));
  return buildings.length ? { ...base, buildings } : base;
}

export default function NewProjectPage() {
  const t = useTranslations('projects');
  const tw = useTranslations('projects.wizard');
  const tt = useTranslations('projects.types');
  const tk = useTranslations('projects.wizard.section');
  // P3 enrichment field labels (migration 0062) + relocation enum labels.
  const tr = useTranslations('projects.wizard.renewal');
  const trel = useTranslations('projects.relocation');
  // Reuse the canonical apartment unit-type labels for the derived
  // section→unit_type tag (residential→apt, office→office, retail→shop, …).
  const tu = useTranslations('apartments.unitType');
  const router = useRouter();
  const mutation = useCreateProject();

  const [state, setState] = useState<WizardState>({
    step: 1,
    name: '',
    type: 'tama38_2',
    description: '',
    consentPct: String(PROJECT_TYPE_DEFAULT_CONSENT_PCT.tama38_2),
    consentTouched: false,
    milestones: [],
    typeLabel: '',
    developerName: '',
    developerCompanyId: '',
    existingUnits: '',
    plannedUnits: '',
    extraAreaSqm: '',
    relocationType: '',
    relocationNotes: '',
    block: '',
    parcel: '',
    subparcel: '',
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
    const mErr = milestoneError();
    if (mErr) return mErr;
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
    setState((s) => {
      // Entering the structure step for tama38_1 (single-building track):
      // ensure exactly one building card is present so the manager fills its
      // address inline rather than having to click "add". An empty card is
      // stripped on submit (toCreateInput filters blanks), so this stays
      // back-compat with the simple no-buildings POST.
      const buildings =
        s.step === 1 && s.type === 'tama38_1' && s.buildings.length === 0
          ? [newBuilding()]
          : s.buildings;
      return { ...s, step: (s.step + 1) as 2 | 3, buildings };
    });
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
    setState((s) =>
      s.buildings.length >= MAX_BUILDINGS_BY_TYPE[s.type]
        ? s
        : { ...s, buildings: [...s.buildings, newBuilding()] },
    );
  }
  function removeBuilding(rid: string) {
    setState((s) => ({ ...s, buildings: s.buildings.filter((b) => b.rid !== rid) }));
  }

  function patchSection(rid: string, sid: string, patch: Partial<WizardSection>) {
    setState((s) => ({
      ...s,
      buildings: s.buildings.map((b) =>
        b.rid === rid
          ? {
              ...b,
              sections: b.sections.map((sec) => (sec.sid === sid ? { ...sec, ...patch } : sec)),
            }
          : b,
      ),
    }));
  }
  function addSection(rid: string) {
    setState((s) => ({
      ...s,
      buildings: s.buildings.map((b) =>
        b.rid === rid && b.sections.length < MAX_SECTIONS_PER_BUILDING
          ? { ...b, sections: [...b.sections, newSection()] }
          : b,
      ),
    }));
  }
  function removeSection(rid: string, sid: string) {
    // Keep at least one section per building — a building with zero sections
    // is a degenerate structure the wizard shouldn't emit.
    setState((s) => ({
      ...s,
      buildings: s.buildings.map((b) =>
        b.rid === rid && b.sections.length > 1
          ? { ...b, sections: b.sections.filter((sec) => sec.sid !== sid) }
          : b,
      ),
    }));
  }

  // Type drives BOTH the consent-target default and the building topology.
  // On change we (a) re-seed targetSignaturePct from the per-type default
  // unless the manager has manually edited it, and (b) clamp the existing
  // buildings list to the new type's max (tama38_1 → 1, tama38_2 → 2,
  // pinui_binui → many) so the structure step can't carry over an invalid count.
  function changeType(type: ProjectType) {
    setState((s) => ({
      ...s,
      type,
      consentPct: s.consentTouched ? s.consentPct : String(PROJECT_TYPE_DEFAULT_CONSENT_PCT[type]),
      buildings: s.buildings.slice(0, MAX_BUILDINGS_BY_TYPE[type]),
    }));
  }

  // ── Milestone (יעדי ביניים) list-editor handlers ─────────────────────────
  function patchMilestone(mid: string, patch: Partial<WizardMilestone>) {
    setState((s) => ({
      ...s,
      milestones: s.milestones.map((m) => (m.mid === mid ? { ...m, ...patch } : m)),
    }));
  }
  function addMilestone() {
    setState((s) =>
      s.milestones.length >= MAX_MILESTONES
        ? s
        : { ...s, milestones: [...s.milestones, newMilestone()] },
    );
  }
  function removeMilestone(mid: string) {
    setState((s) => ({ ...s, milestones: s.milestones.filter((m) => m.mid !== mid) }));
  }
  // Sort the milestone rows ascending by pct (stable; blanks sink to the end).
  // Called on blur so the user sees the canonical order before submit.
  function sortMilestones() {
    setState((s) => ({
      ...s,
      milestones: [...s.milestones].sort((a, b) => {
        const pa = a.pct.trim() === '' ? Number.POSITIVE_INFINITY : Number(a.pct);
        const pb = b.pct.trim() === '' ? Number.POSITIVE_INFINITY : Number(b.pct);
        return pa - pb;
      }),
    }));
  }
  // "Suggest" seeds [25, 50, target] (deduped, < target only) — a sensible
  // staged default the manager can then edit. Replaces any current rows.
  function suggestMilestones() {
    setState((s) => {
      const target = Number(s.consentPct.trim());
      const hasTarget = s.consentPct.trim() !== '' && Number.isFinite(target);
      const seed = [25, 50, hasTarget ? target : 66];
      const seen = new Set<number>();
      const rows = seed
        .filter((p) => (hasTarget ? p <= target : true))
        .filter((p) => (seen.has(p) ? false : (seen.add(p), true)))
        .sort((a, b) => a - b)
        .slice(0, MAX_MILESTONES)
        .map((p) => newMilestone(String(p)));
      return { ...s, milestones: rows };
    });
  }
  /** Client-side milestone validity message (progressive disclosure only; the
   *  CreateProjectInput.safeParse boundary on submit is authoritative). Checks
   *  0 < pct <= target, ascending, unique across the filled rows. */
  function milestoneError(): string | null {
    const target = state.consentPct.trim() === '' ? null : Number(state.consentPct.trim());
    const filled = state.milestones.filter((m) => m.pct.trim() !== '');
    const nums: number[] = [];
    for (const m of filled) {
      const n = Number(m.pct);
      if (!Number.isInteger(n) || n <= 0 || n > 100) return tw('milestones.errorRange');
      if (target !== null && Number.isFinite(target) && n > target) {
        return tw('milestones.errorOverTarget');
      }
      nums.push(n);
    }
    const sorted = [...nums].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] === sorted[i - 1]) return tw('milestones.errorDuplicate');
    }
    return null;
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

  // Per-kind progressive-disclosure hint (owner point 2): residential is
  // rooms/floors-oriented, office/retail are AREA-oriented, mixed prompts
  // for multiple sections.
  function kindHint(k: SectionKind): string {
    return k === 'residential'
      ? tk('residentialHint')
      : k === 'office'
        ? tk('officeHint')
        : k === 'retail'
          ? tk('retailHint')
          : tk('mixedHint');
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
        <h1 className="text-foreground text-lg font-semibold">{t('create')}</h1>
        <ol className="flex items-center gap-2" aria-label={t('create')}>
          {[1, 2, 3].map((n) => {
            const active = state.step === n;
            const done = state.step > n;
            const filled = active || done;
            return (
              <li key={n} className="flex items-center gap-2">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold ${
                    filled
                      ? 'border-navy-900 bg-navy-900 text-white'
                      : 'bg-surface-subtle text-muted border-border'
                  }`}
                  aria-current={active ? 'step' : undefined}
                >
                  {n}
                </div>
                <span
                  className={`text-xs ${active ? 'text-foreground font-semibold' : 'text-muted'}`}
                >
                  {n === 1 ? tw('step1') : n === 2 ? tw('step2') : tw('step3')}
                </span>
                {n < 3 && <span aria-hidden="true" className="block h-px w-6 bg-border" />}
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
                onChange={(e) => changeType(e.target.value as ProjectType)}
              >
                {PROJECT_TYPES.map((pt) => (
                  <option key={pt} value={pt}>
                    {tt(pt)}
                  </option>
                ))}
              </select>
            </div>

            {/* Minimal-create affordance: name + type is enough; the rest is
                optional. Makes "create empty, enrich later" explicit. */}
            <p className="text-muted bg-surface-subtle rounded-md p-2 text-xs">
              {tw('minimalCreateHint')}
            </p>

            <div>
              <label htmlFor="consentPct" className="label">
                {tw('consentTarget')}
              </label>
              <input
                id="consentPct"
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                className="input tabular"
                dir="ltr"
                value={state.consentPct}
                onChange={(e) =>
                  setState((s) => ({ ...s, consentPct: e.target.value, consentTouched: true }))
                }
              />
              <p className="text-muted mt-1 text-xs">{tw('consentTargetHint')}</p>
            </div>

            {/* Owner-approved staged overlay (Gate-6, Option A): optional
                ordered intermediate signature targets (יעדי ביניים) under the
                legal consent gate. Add/remove rows of pct + optional label;
                auto-sorted ascending on blur. */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="label" style={{ marginBottom: 0 }}>
                  {tw('milestones.title')}
                </span>
                <button type="button" onClick={suggestMilestones} className="btn btn-ghost btn-sm">
                  {tw('milestones.suggest')}
                </button>
              </div>
              <p className="text-muted text-xs">{tw('milestones.hint')}</p>
              {state.milestones.length === 0 && (
                <p className="text-soft text-xs">{tw('milestones.empty')}</p>
              )}
              {state.milestones.map((m, idx) => (
                <div key={m.mid} className="flex items-end gap-2">
                  <div style={{ width: 96 }}>
                    <label className="label" htmlFor={`m-${m.mid}-pct`}>
                      {tw('milestones.pct')}
                    </label>
                    <input
                      id={`m-${m.mid}-pct`}
                      type="number"
                      min={1}
                      max={100}
                      inputMode="numeric"
                      className="input tabular"
                      dir="ltr"
                      value={m.pct}
                      onChange={(e) => patchMilestone(m.mid, { pct: e.target.value })}
                      onBlur={sortMilestones}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="label" htmlFor={`m-${m.mid}-label`}>
                      {tw('milestones.label')}
                    </label>
                    <input
                      id={`m-${m.mid}-label`}
                      type="text"
                      className="input"
                      value={m.label}
                      maxLength={80}
                      onChange={(e) => patchMilestone(m.mid, { label: e.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeMilestone(m.mid)}
                    className="btn btn-ghost btn-sm text-status-danger-fg"
                    aria-label={tw('milestones.remove', { n: idx + 1 })}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
              {state.milestones.length < MAX_MILESTONES && (
                <div>
                  <button type="button" onClick={addMilestone} className="btn btn-ghost btn-sm">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{tw('milestones.add')}</span>
                  </button>
                </div>
              )}
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

            {/* P3 create-form enrichment (migration 0062) — optional renewal
                details: developer (יזם), תמורה ratio, relocation (פינוי,
                demolish-rebuild only) and parcel provenance (גוש-חלקה). All
                additive + optional; collapsed into one labelled section so the
                minimal name+type create stays unchanged. */}
            <fieldset className="border-border flex flex-col gap-3 rounded-md border p-3">
              <legend className="text-muted px-1 text-xs font-medium">{tr('sectionTitle')}</legend>
              <p className="text-muted text-xs">{tr('sectionHint')}</p>

              {/* Future-track free-text label — only for the 'other' type. */}
              {state.type === 'other' && (
                <div>
                  <label htmlFor="typeLabel" className="label">
                    {tr('typeLabel')}
                  </label>
                  <input
                    id="typeLabel"
                    type="text"
                    className="input"
                    maxLength={120}
                    value={state.typeLabel}
                    onChange={(e) => setState((s) => ({ ...s, typeLabel: e.target.value }))}
                  />
                  <p className="text-muted mt-1 text-xs">{tr('typeLabelHint')}</p>
                </div>
              )}

              {/* Developer (יזם) */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="developerName" className="label">
                    {tr('developerName')}
                  </label>
                  <input
                    id="developerName"
                    type="text"
                    className="input"
                    maxLength={200}
                    value={state.developerName}
                    onChange={(e) => setState((s) => ({ ...s, developerName: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="developerCompanyId" className="label">
                    {tr('developerCompanyId')}
                  </label>
                  <input
                    id="developerCompanyId"
                    type="text"
                    className="input tabular"
                    dir="ltr"
                    maxLength={40}
                    value={state.developerCompanyId}
                    onChange={(e) =>
                      setState((s) => ({ ...s, developerCompanyId: e.target.value }))
                    }
                  />
                </div>
              </div>

              {/* תמורה ratio */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="existingUnits" className="label">
                    {tr('existingUnits')}
                  </label>
                  <input
                    id="existingUnits"
                    type="number"
                    min={0}
                    max={100000}
                    inputMode="numeric"
                    className="input tabular"
                    dir="ltr"
                    value={state.existingUnits}
                    onChange={(e) => setState((s) => ({ ...s, existingUnits: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="plannedUnits" className="label">
                    {tr('plannedUnits')}
                  </label>
                  <input
                    id="plannedUnits"
                    type="number"
                    min={0}
                    max={100000}
                    inputMode="numeric"
                    className="input tabular"
                    dir="ltr"
                    value={state.plannedUnits}
                    onChange={(e) => setState((s) => ({ ...s, plannedUnits: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="extraAreaSqm" className="label">
                    {tr('extraAreaSqm')}
                  </label>
                  <input
                    id="extraAreaSqm"
                    type="number"
                    min={0}
                    inputMode="decimal"
                    className="input tabular"
                    dir="ltr"
                    value={state.extraAreaSqm}
                    onChange={(e) => setState((s) => ({ ...s, extraAreaSqm: e.target.value }))}
                  />
                </div>
              </div>
              <p className="text-muted text-xs">{tr('tmuraHint')}</p>

              {/* Relocation (פינוי) — demolish-rebuild tracks only. */}
              {isRelocationRelevant(state.type) && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="relocationType" className="label">
                      {tr('relocationType')}
                    </label>
                    <select
                      id="relocationType"
                      className="input"
                      value={state.relocationType}
                      onChange={(e) =>
                        setState((s) => ({
                          ...s,
                          relocationType: e.target.value as '' | RelocationType,
                        }))
                      }
                    >
                      <option value="">{trel('unspecified')}</option>
                      {RELOCATION_TYPES.map((rt) => (
                        <option key={rt} value={rt}>
                          {trel(rt)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="relocationNotes" className="label">
                      {tr('relocationNotes')}
                    </label>
                    <input
                      id="relocationNotes"
                      type="text"
                      className="input"
                      maxLength={2000}
                      value={state.relocationNotes}
                      onChange={(e) => setState((s) => ({ ...s, relocationNotes: e.target.value }))}
                    />
                  </div>
                </div>
              )}

              {/* Parcel provenance (גוש-חלקה) */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="block" className="label">
                    {tr('block')}
                  </label>
                  <input
                    id="block"
                    type="text"
                    className="input tabular"
                    dir="ltr"
                    maxLength={40}
                    value={state.block}
                    onChange={(e) => setState((s) => ({ ...s, block: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="parcel" className="label">
                    {tr('parcel')}
                  </label>
                  <input
                    id="parcel"
                    type="text"
                    className="input tabular"
                    dir="ltr"
                    maxLength={40}
                    value={state.parcel}
                    onChange={(e) => setState((s) => ({ ...s, parcel: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="subparcel" className="label">
                    {tr('subparcel')}
                  </label>
                  <input
                    id="subparcel"
                    type="text"
                    className="input tabular"
                    dir="ltr"
                    maxLength={40}
                    value={state.subparcel}
                    onChange={(e) => setState((s) => ({ ...s, subparcel: e.target.value }))}
                  />
                </div>
              </div>
              <p className="text-muted text-xs">{tr('parcelHint')}</p>
            </fieldset>
          </>
        )}

        {state.step === 2 && (
          <>
            {/* Type-aware structure guidance. tama38_1 = one building;
                tama38_2 = up to two; pinui_binui = a multi-building complex
                with a live count. */}
            {state.type === 'tama38_1' && (
              <p className="text-muted text-sm">{tw('singleBuildingHint')}</p>
            )}
            {state.type === 'tama38_2' && (
              <p className="text-muted text-sm">{tw('twoBuildingHint')}</p>
            )}
            {state.type === 'pinui_binui' && (
              <p className="text-foreground text-sm font-medium">
                {tw('complexBuildingCount', { n: state.buildings.length })}
              </p>
            )}
            {state.buildings.length === 0 && state.type !== 'tama38_1' && (
              <p className="text-muted text-sm">{tw('noBuildings')}</p>
            )}
            {state.buildings.map((b, idx) => (
              <fieldset key={b.rid} className="border-border rounded-md border p-3">
                <legend className="text-muted px-1 text-xs font-medium">
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
                </div>

                {/* Sections (אגפים) — one-or-more per building. Each carries a
                    `kind` that drives progressive disclosure of its fields:
                    residential → rooms/floors; office/retail → AREA (שטח).
                    A real mixed-use building = ≥2 sections of different kinds. */}
                <div className="mt-3 flex flex-col gap-3">
                  {b.sections.some((sec) => sec.kind === 'mixed') && (
                    <p className="text-muted text-xs">{tk('mixedMultiSectionHint')}</p>
                  )}
                  {b.sections.map((sec, sIdx) => {
                    return (
                      <fieldset
                        key={sec.sid}
                        className="border-border bg-surface-subtle rounded-md border p-3"
                      >
                        <legend className="text-muted px-1 text-xs font-medium">
                          {tk('sectionNumberLabel', { n: sIdx + 1 })}
                        </legend>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <label className="label" htmlFor={`s-${sec.sid}-kind`}>
                              {tw('section.kind')}
                            </label>
                            <select
                              id={`s-${sec.sid}-kind`}
                              className="input"
                              value={sec.kind}
                              onChange={(e) =>
                                patchSection(b.rid, sec.sid, {
                                  kind: e.target.value as SectionKind,
                                })
                              }
                            >
                              {SECTION_KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                  {kindLabel(kind)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="label" htmlFor={`s-${sec.sid}-entrance`}>
                              {tk('entrance')}
                            </label>
                            <input
                              id={`s-${sec.sid}-entrance`}
                              type="text"
                              className="input"
                              value={sec.entrance}
                              onChange={(e) =>
                                patchSection(b.rid, sec.sid, { entrance: e.target.value })
                              }
                            />
                          </div>
                          {/* Floors: kept for every kind, but de-emphasised for
                              retail (typically single-floor). */}
                          <div style={sec.kind === 'retail' ? { opacity: 0.7 } : undefined}>
                            <label className="label" htmlFor={`s-${sec.sid}-floors`}>
                              {tw('field.floors')}
                            </label>
                            <input
                              id={`s-${sec.sid}-floors`}
                              type="number"
                              min={0}
                              max={200}
                              className="input tabular"
                              dir="ltr"
                              value={sec.floors}
                              onChange={(e) =>
                                patchSection(b.rid, sec.sid, { floors: e.target.value })
                              }
                            />
                          </div>
                          {/* Unit COUNT for every kind. The label/measure differs:
                              residential counts apartments; office/retail count
                              units measured by area. */}
                          <div>
                            <label className="label" htmlFor={`s-${sec.sid}-units`}>
                              {tw('field.unitCount')}
                            </label>
                            <input
                              id={`s-${sec.sid}-units`}
                              type="number"
                              min={0}
                              max={2000}
                              className="input tabular"
                              dir="ltr"
                              value={sec.unitCount}
                              onChange={(e) =>
                                patchSection(b.rid, sec.sid, { unitCount: e.target.value })
                              }
                            />
                          </div>
                          {/* N16 (e2 wave-4 c5): the per-section AREA (שטח) input
                              was removed. CreateProjectSectionInput has no area
                              column, so the value was collected then silently
                              dropped on the wire — a data-integrity/honesty issue.
                              The kind-hint below still names the area framing for
                              office/retail; re-add the input WITH a wire column
                              (Gate-6, schema change) when it can actually persist. */}
                        </div>
                        <p className="text-muted mt-2 text-xs">
                          {kindHint(sec.kind)}{' '}
                          <span style={{ fontWeight: 500 }}>
                            ({tu(SECTION_KIND_DEFAULT_UNIT_TYPE[sec.kind])})
                          </span>
                        </p>
                        {b.sections.length > 1 && (
                          <div className="mt-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => removeSection(b.rid, sec.sid)}
                              className="btn btn-ghost btn-sm text-status-danger-fg"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>{tk('removeSection')}</span>
                            </button>
                          </div>
                        )}
                      </fieldset>
                    );
                  })}
                  {b.sections.length < MAX_SECTIONS_PER_BUILDING && (
                    <div>
                      <button
                        type="button"
                        onClick={() => addSection(b.rid)}
                        className="btn btn-ghost btn-sm"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{tk('addSection')}</span>
                      </button>
                    </div>
                  )}
                </div>
                {/* tama38_1 is a single-building track — no removal (it would
                    leave the project with zero buildings). */}
                {state.type !== 'tama38_1' && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => removeBuilding(b.rid)}
                      className="btn btn-ghost btn-sm text-status-danger-fg"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{tw('removeBuilding')}</span>
                    </button>
                  </div>
                )}
              </fieldset>
            ))}
            {/* Add is hidden once the type's building cap is reached
                (tama38_1 → 1, tama38_2 → 2, pinui_binui → 20). */}
            {state.buildings.length < MAX_BUILDINGS_BY_TYPE[state.type] && (
              <div>
                <button type="button" onClick={addBuilding} className="btn btn-secondary">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>{tw('addBuilding')}</span>
                </button>
              </div>
            )}
          </>
        )}

        {state.step === 3 && (
          <>
            <section aria-labelledby="rev-proj-h">
              <h2 id="rev-proj-h" className="text-sm font-semibold">
                {tw('review.projectHeading')}
              </h2>
              <dl className="mt-2 grid grid-cols-[120px_1fr] gap-y-1 text-sm">
                <dt className="text-muted">{t('field.name')}</dt>
                <dd>{state.name}</dd>
                <dt className="text-muted">{t('field.type')}</dt>
                <dd>{tt(state.type)}</dd>
                {state.consentPct.trim() !== '' && (
                  <>
                    <dt className="text-muted">{tw('consentTarget')}</dt>
                    <dd className="tabular" dir="ltr">
                      {state.consentPct}%
                    </dd>
                  </>
                )}
                {state.type === 'other' && state.typeLabel.trim() && (
                  <>
                    <dt className="text-muted">{tr('typeLabel')}</dt>
                    <dd>{state.typeLabel.trim()}</dd>
                  </>
                )}
                {state.developerName.trim() && (
                  <>
                    <dt className="text-muted">{tr('developerName')}</dt>
                    <dd>
                      {state.developerName.trim()}
                      {state.developerCompanyId.trim() && (
                        <span className="tabular ms-2" dir="ltr">
                          ({state.developerCompanyId.trim()})
                        </span>
                      )}
                    </dd>
                  </>
                )}
                {(state.existingUnits.trim() || state.plannedUnits.trim()) && (
                  <>
                    <dt className="text-muted">{tr('existingUnits')}</dt>
                    <dd className="tabular" dir="ltr">
                      {state.existingUnits.trim() || '—'} → {state.plannedUnits.trim() || '—'}
                    </dd>
                  </>
                )}
                {isRelocationRelevant(state.type) && state.relocationType !== '' && (
                  <>
                    <dt className="text-muted">{tr('relocationType')}</dt>
                    <dd>{trel(state.relocationType)}</dd>
                  </>
                )}
                {(state.block.trim() || state.parcel.trim() || state.subparcel.trim()) && (
                  <>
                    <dt className="text-muted">{tw('field.block')}</dt>
                    <dd className="tabular" dir="ltr">
                      {state.block.trim() || '—'} / {state.parcel.trim() || '—'}
                      {state.subparcel.trim() && ` / ${state.subparcel.trim()}`}
                    </dd>
                  </>
                )}
                {state.description && (
                  <>
                    <dt className="text-muted">{t('field.description')}</dt>
                    <dd className="whitespace-pre-wrap">{state.description}</dd>
                  </>
                )}
              </dl>
            </section>

            <section aria-labelledby="rev-bld-h" className="border-border border-t pt-3">
              <h2 id="rev-bld-h" className="text-sm font-semibold">
                {tw('review.buildingsHeading', { n: state.buildings.length })}
              </h2>
              {state.buildings.length === 0 ? (
                <p className="text-muted mt-2 text-xs">{tw('review.noBuildings')}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {state.buildings.map((b, idx) => (
                    <li key={b.rid} className="border-border rounded-md border p-3 text-sm">
                      <div className="flex items-center gap-2 font-medium">
                        <Building2 className="text-navy-700 h-4 w-4" aria-hidden="true" />
                        <span>{tw('buildingNumberLabel', { n: idx + 1 })}</span>
                      </div>
                      <div className="text-muted mt-1 text-xs">
                        {[b.address, b.city].filter(Boolean).join(', ')}
                        {b.block || b.parcel
                          ? ` · ${tw('field.block')} ${b.block || '—'} / ${tw('field.parcel')} ${b.parcel || '—'}`
                          : ''}
                      </div>
                      <div className="text-muted mt-1 text-xs">
                        {tw('review.sectionsLabel')}:{' '}
                        {b.sections
                          .map((sec) => {
                            const parts = [kindLabel(sec.kind)];
                            if (sec.entrance.trim()) parts.push(sec.entrance.trim());
                            if (sec.floors) parts.push(`${tw('field.floors')} ${sec.floors}`);
                            if (sec.unitCount)
                              parts.push(`${tw('field.unitCount')} ${sec.unitCount}`);
                            return parts.join(' / ');
                          })
                          .join(' · ')}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {stepError && (
          <p className="text-status-danger-fg text-sm" role="alert">
            {stepError}
          </p>
        )}
        {serverError && (
          <p className="text-status-danger-fg text-sm" role="alert">
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
