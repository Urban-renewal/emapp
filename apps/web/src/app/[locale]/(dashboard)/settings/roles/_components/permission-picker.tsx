'use client';

import type { PermissionCatalogEntry } from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

/**
 * Permission picker — groups the BE catalog by resource (the prefix before the
 * first dot) and renders a checkbox per permission. Governance permissions
 * (roles.* / org.*) are marked and, when `governanceLocked` is true (the actor
 * is not an Owner), disabled — a purely UX affordance; the BE is the
 * authoritative gate (it rejects governance permissions for non-Owners).
 *
 * Permissions the actor does NOT hold (`actorPermissions`) are also disabled:
 * a custom role can only grant a subset of the creator's effective set, so
 * offering an un-held permission would only earn a 422.
 */
export function PermissionPicker({
  catalog,
  selected,
  onToggle,
  actorPermissions,
  governanceLocked,
}: {
  catalog: PermissionCatalogEntry[];
  selected: Set<string>;
  onToggle: (permission: string, next: boolean) => void;
  actorPermissions: Set<string>;
  governanceLocked: boolean;
}) {
  const t = useTranslations('roles');

  const groups = useMemo(() => {
    const byResource = new Map<string, PermissionCatalogEntry[]>();
    for (const entry of catalog) {
      const arr = byResource.get(entry.resource) ?? [];
      arr.push(entry);
      byResource.set(entry.resource, arr);
    }
    return [...byResource.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([resource, entries]) => (
        <fieldset key={resource} className="flex flex-col gap-1.5">
          <legend className="text-xs font-semibold" style={{ color: 'var(--text-soft)' }}>
            {resource}
          </legend>
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
          >
            {entries.map((entry) => {
              const held = actorPermissions.has(entry.permission);
              const governanceBlocked = entry.governance && governanceLocked;
              const disabled = !held || governanceBlocked;
              const checked = selected.has(entry.permission);
              return (
                <label
                  key={entry.permission}
                  className="flex items-center gap-2 text-[13px]"
                  style={{ color: disabled ? 'var(--text-muted)' : 'var(--text)' }}
                  title={
                    governanceBlocked
                      ? t('picker.governanceLockedHint')
                      : !held
                        ? t('picker.notHeldHint')
                        : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onToggle(entry.permission, e.target.checked)}
                  />
                  <span className="truncate" dir="ltr">
                    {entry.permission}
                  </span>
                  {entry.governance && (
                    <span className="badge badge-warning shrink-0">{t('picker.governance')}</span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
