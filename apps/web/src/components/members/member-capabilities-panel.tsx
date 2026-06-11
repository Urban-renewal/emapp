'use client';

import {
  DEFAULT_AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentCapabilityKey,
} from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import {
  useApplyCapabilityPreset,
  useCapabilityPresets,
  useUpdateMemberCapabilities,
} from '@/hooks/use-members';
import { useDisplayLocale } from '@/lib/locale';
import type { MemberViewModel } from '@/models/member.vm';

/**
 * D.46 / D.54 — agent capability matrix editor (Manager-only surface; the
 * /members route is already manager-gated).
 *
 * Roles are PRESETS (D.54): Manager implicitly holds ALL; Viewer holds
 * none (read-only, PII masked). Only `role==='agent'` has an editable
 * capability set — the BE rejects a capabilities PATCH on any other role
 * (`capabilities_agent_only`). So for manager/viewer we render the preset
 * description read-only; for agent we render the toggles.
 *
 * Invariant reflected in the UI (server-enforced too): `view_owner_pii`
 * ⇒ `view_owners`. Turning `view_owners` OFF force-clears `view_owner_pii`
 * and disables it; you cannot grant unmasked PII without "view owners".
 *
 * The five write groups (D.54) + `view_owners` + `view_owner_pii` are the
 * curated set. We submit the full set (the BE merges a subset and
 * re-validates); the agent's next request loads the new flags server-side
 * (capabilities are NOT in the JWT — no re-login needed).
 */
interface Props {
  member: MemberViewModel;
}

/** The five coarse write groups (D.54) — order is the display order. */
const WRITE_GROUPS: AgentCapabilityKey[] = [
  'edit_project_data',
  'manage_documents',
  'manage_signatures',
  'manage_tasks',
  'run_imports',
];

export function MemberCapabilitiesPanel({ member }: Props) {
  const t = useTranslations('members.capabilities');
  const locale = useDisplayLocale();
  const mutation = useUpdateMemberCapabilities();
  const presetsQuery = useCapabilityPresets();
  const applyPresetMutation = useApplyCapabilityPreset();
  const [caps, setCaps] = useState<AgentCapabilities>(member.capabilities);
  const [saved, setSaved] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState('');

  // Re-seed only when we navigate to a DIFFERENT member (keyed on userId),
  // not on every list-refetch identity change — otherwise a background
  // refetch (staleTime/focus) would clobber the manager's in-progress edits.
  useEffect(() => {
    setCaps(member.capabilities);
    setSaved(false);
    setSelectedPreset('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per member; capabilities intentionally read at seed time only
  }, [member.userId]);

  const { serverError, handle, reset } = useApiErrorHandler<AgentCapabilities>({
    codeOverrides: {
      capabilities_agent_only: () => t('agentOnly'),
      view_owner_pii_requires_view_owners: () => t('piiRequiresViewOwners'),
    },
    fallback: () => t('saveFailed'),
  });

  // Manager / Viewer: preset description only (no editable matrix).
  if (member.role !== 'agent') {
    return (
      <div className="rounded-md border bg-card p-4">
        <h2 className="mb-2 text-base font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">
          {member.role === 'manager' ? t('presetManager') : t('presetViewer')}
        </p>
      </div>
    );
  }

  function setFlag(key: AgentCapabilityKey, value: boolean) {
    setSaved(false);
    setCaps((prev) => {
      const next = { ...prev, [key]: value };
      // Invariant: pii ⇒ view_owners. Turning view_owners off clears pii.
      if (key === 'view_owners' && !value) next.view_owner_pii = false;
      return next;
    });
  }

  const dirty = (Object.keys(caps) as AgentCapabilityKey[]).some(
    (k) => caps[k] !== member.capabilities[k],
  );

  async function onSave() {
    reset();
    setSaved(false);
    try {
      await mutation.mutateAsync({ userId: member.userId, body: caps });
      setSaved(true);
    } catch (e) {
      handle(e);
    }
  }

  function onResetPreset() {
    setSaved(false);
    reset();
    // Agent preset = the locked least-privilege floor (D.54).
    setCaps(DEFAULT_AGENT_CAPABILITIES);
  }

  // S4b #8 — apply a NAMED preset: the BE sets the agent's flags to the
  // preset bundle (reusing the capabilities path) and returns the updated
  // member; on success we reflect the bundle in the local toggles so the
  // manager can still fine-tune below.
  const presets = presetsQuery.data ?? [];
  const activePreset = presets.find((p) => p.key === selectedPreset);

  async function onApplyPreset() {
    if (!activePreset) return;
    reset();
    setSaved(false);
    try {
      await applyPresetMutation.mutateAsync({
        userId: member.userId,
        body: { presetKey: activePreset.key },
      });
      setCaps(activePreset.capabilities);
      setSaved(true);
    } catch (e) {
      handle(e);
    }
  }

  const canSave = !member.isRevoked && dirty && !mutation.isPending;

  return (
    <div className="rounded-md border bg-card p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={member.isRevoked || mutation.isPending}
          onClick={onResetPreset}
        >
          {t('resetPreset')}
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('hint')}</p>

      {/* §S1-SEC1 — method="post" defense in depth (no GET-fallback leak). */}
      <form
        method="post"
        action=""
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        className="space-y-4"
      >
        {/* S4b #8 — named preset picker. Pick a Hebrew/English-labelled role
            preset + "apply" to set all 7 flags at once; the raw toggles below
            remain for fine-tuning. */}
        <fieldset className="space-y-2 border-b pb-4" disabled={member.isRevoked}>
          <legend className="text-sm font-medium">{t('presetSection')}</legend>
          <p className="text-xs text-muted-foreground">{t('presetHint')}</p>
          <div className="flex flex-wrap items-end gap-2">
            <select
              aria-label={t('presetSection')}
              className="min-w-48 flex-1 rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
              value={selectedPreset}
              disabled={presetsQuery.isLoading || applyPresetMutation.isPending}
              onChange={(e) => setSelectedPreset(e.target.value)}
            >
              <option value="">{t('presetPlaceholder')}</option>
              {presets.map((p) => (
                <option key={p.key} value={p.key} dir="auto">
                  {locale === 'en' ? p.nameEn : p.nameHe}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              disabled={!activePreset || applyPresetMutation.isPending}
              onClick={onApplyPreset}
            >
              {applyPresetMutation.isPending ? t('applyingPreset') : t('applyPreset')}
            </Button>
          </div>
          {activePreset && (
            <p className="text-xs text-muted-foreground" dir="auto">
              {locale === 'en' ? activePreset.descriptionEn : activePreset.descriptionHe}
            </p>
          )}
        </fieldset>

        {/* Read scope. */}
        <fieldset className="space-y-2" disabled={member.isRevoked}>
          <legend className="text-sm font-medium">{t('readSection')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={caps.view_owners}
              onChange={(e) => setFlag('view_owners', e.target.checked)}
            />
            <span>{t('cap.view_owners')}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={caps.view_owner_pii}
              // Invariant: cannot grant unmasked PII without view_owners.
              disabled={!caps.view_owners}
              onChange={(e) => setFlag('view_owner_pii', e.target.checked)}
            />
            <span className={!caps.view_owners ? 'text-muted-foreground' : undefined}>
              {t('cap.view_owner_pii')}
            </span>
          </label>
          {!caps.view_owners && (
            <p className="text-xs text-muted-foreground">{t('piiNeedsViewOwners')}</p>
          )}
        </fieldset>

        {/* Write groups (coarse, D.54). */}
        <fieldset className="space-y-2" disabled={member.isRevoked}>
          <legend className="text-sm font-medium">{t('writeSection')}</legend>
          {WRITE_GROUPS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={caps[key]}
                onChange={(e) => setFlag(key, e.target.checked)}
              />
              <span>{t(`cap.${key}`)}</span>
            </label>
          ))}
        </fieldset>

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}
        {/* `saved` is cleared by any subsequent toggle (setFlag), so this
            shows only between a successful save and the next edit. */}
        {saved && <p className="text-sm text-emerald-700">{t('savedOk')}</p>}

        <div className="flex items-center justify-end">
          <Button type="submit" disabled={!canSave}>
            {mutation.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
