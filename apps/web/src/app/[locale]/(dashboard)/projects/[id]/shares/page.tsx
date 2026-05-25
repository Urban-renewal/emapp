'use client';

import type { CreateShare, SharePermissions } from '@emapp/shared-types';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useContractorList } from '@/hooks/use-contractors';
import { useCreateProjectShare, useProjectShareList, useRevokeShare } from '@/hooks/use-shares';
import { SHARE_DEFAULT_PERMISSIONS } from '@/models/share.vm';

/**
 * Project shares — D.17 read=ALL, write=MGR. Lists current shares
 * with permission summary; the Manager can grant new shares by
 * picking a contractor + toggling permissions.
 *
 * The permissions form mirrors `SharePermissionsSchema` exactly —
 * any unknown key is rejected client-side by Zod BEFORE the wire
 * (matches BE .strict()). The form composes only legal toggles so
 * unknown keys are structurally impossible.
 */
export default function ProjectSharesPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params?.id;
  const t = useTranslations('shares');
  const tp = useTranslations('projects');

  const contractorsQuery = useContractorList({ limit: 100 });
  const contractorIdToName = useMemo(() => {
    if (!contractorsQuery.data) return undefined;
    const m = new Map<string, string>();
    for (const c of contractorsQuery.data.items) m.set(c.id, c.name);
    return m;
  }, [contractorsQuery.data]);

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const sharesQuery = useProjectShareList(projectId, { limit: 25, cursor }, contractorIdToName);
  const items = sharesQuery.data?.items ?? [];

  const [contractorId, setContractorId] = useState('');
  const [perms, setPerms] = useState<SharePermissions>(SHARE_DEFAULT_PERMISSIONS);

  const createMutation = useCreateProjectShare(projectId);
  const revokeMutation = useRevokeShare(projectId);

  const createError = useApiErrorHandler<CreateShare>({
    codeOverrides: {
      share_exists: () => t('shareExists'),
      forbidden: () => t('forbidden'),
    },
    fallback: () => t('createFailed'),
  });

  async function onGrant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!projectId || !contractorId) return;
    createError.reset();
    try {
      await createMutation.mutateAsync({ contractorId, permissions: perms });
      setContractorId('');
      setPerms(SHARE_DEFAULT_PERMISSIONS);
    } catch (e) {
      createError.handle(e);
    }
  }

  async function onRevoke(id: string) {
    if (!window.confirm(t('revokeConfirm'))) return;
    try {
      await revokeMutation.mutateAsync(id);
    } catch (e) {
      createError.handle(e);
    }
  }

  // Eligible contractors — non-archived AND not already granted.
  const granted = new Set(items.map((s) => s.contractorId));
  const eligibleContractors = (contractorsQuery.data?.items ?? []).filter(
    (c) => !c.isArchived && !granted.has(c.id),
  );

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Button variant="ghost" onClick={() => projectId && router.push(`/projects/${projectId}`)}>
          {t('backToProject')}
        </Button>
      </div>

      <div className="rounded-md border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">{t('grantSection')}</h2>
        <form method="post" action="" onSubmit={onGrant} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="contractorId" className="text-sm font-medium">
              {t('field.contractor')}
            </label>
            <select
              id="contractorId"
              value={contractorId}
              onChange={(e) => setContractorId(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="" dir="auto">
                {t('field.contractorPlaceholder')}
              </option>
              {eligibleContractors.map((c) => (
                <option key={c.id} value={c.id} dir="auto">
                  {c.name} · {c.contactEmail}
                </option>
              ))}
            </select>
            {eligibleContractors.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('noEligibleContractors')}</p>
            )}
          </div>

          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-2 text-xs font-medium">{t('permissionsLegend')}</legend>

            <PermToggle
              label={t('perm.overview')}
              checked={perms.overview.on}
              onChange={(on) => setPerms({ ...perms, overview: { on } })}
            />

            <PermToggle
              label={t('perm.tenants')}
              checked={perms.tenants.on}
              onChange={(on) => setPerms({ ...perms, tenants: { ...perms.tenants, on } })}
            />
            {perms.tenants.on && (
              <div className="ms-6 space-y-1 text-xs text-muted-foreground">
                <SubToggle
                  label={t('perm.tenantsField.phone')}
                  checked={perms.tenants.fields.phone}
                  onChange={(v) =>
                    setPerms({
                      ...perms,
                      tenants: { ...perms.tenants, fields: { ...perms.tenants.fields, phone: v } },
                    })
                  }
                />
                <SubToggle
                  label={t('perm.tenantsField.email')}
                  checked={perms.tenants.fields.email}
                  onChange={(v) =>
                    setPerms({
                      ...perms,
                      tenants: { ...perms.tenants, fields: { ...perms.tenants.fields, email: v } },
                    })
                  }
                />
                <SubToggle
                  label={t('perm.tenantsField.national_id')}
                  checked={perms.tenants.fields.national_id}
                  onChange={(v) =>
                    setPerms({
                      ...perms,
                      tenants: {
                        ...perms.tenants,
                        fields: { ...perms.tenants.fields, national_id: v },
                      },
                    })
                  }
                />
                <SubToggle
                  label={t('perm.tenantsField.note')}
                  checked={perms.tenants.fields.note}
                  onChange={(v) =>
                    setPerms({
                      ...perms,
                      tenants: { ...perms.tenants, fields: { ...perms.tenants.fields, note: v } },
                    })
                  }
                />
              </div>
            )}

            <PermToggle
              label={t('perm.documents')}
              checked={perms.documents.on}
              onChange={(on) => setPerms({ ...perms, documents: { ...perms.documents, on } })}
            />
            {perms.documents.on && (
              <div className="ms-6 space-y-1 text-xs text-muted-foreground">
                <SubToggle
                  label={t('perm.documentAction.download')}
                  checked={perms.documents.actions.download}
                  onChange={(v) =>
                    setPerms({
                      ...perms,
                      documents: {
                        ...perms.documents,
                        actions: { ...perms.documents.actions, download: v },
                      },
                    })
                  }
                />
                <SubToggle
                  label={t('perm.documentAction.upload')}
                  checked={perms.documents.actions.upload}
                  onChange={(v) =>
                    setPerms({
                      ...perms,
                      documents: {
                        ...perms.documents,
                        actions: { ...perms.documents.actions, upload: v },
                      },
                    })
                  }
                />
              </div>
            )}

            <PermToggle
              label={t('perm.signatures')}
              checked={perms.signatures.on}
              onChange={(on) => setPerms({ ...perms, signatures: { on } })}
            />
            <PermToggle
              label={t('perm.notes')}
              checked={perms.notes.on}
              onChange={(on) => setPerms({ ...perms, notes: { on } })}
            />
            <PermToggle
              label={t('perm.team')}
              checked={perms.team.on}
              onChange={(on) => setPerms({ ...perms, team: { on } })}
            />
          </fieldset>

          {createError.serverError && (
            <p className="text-sm text-destructive">{createError.serverError}</p>
          )}

          <div className="flex items-center justify-end">
            <Button type="submit" disabled={!contractorId || createMutation.isPending}>
              {createMutation.isPending ? t('granting') : t('grant')}
            </Button>
          </div>
        </form>
      </div>

      <ListPageShell
        isLoading={sharesQuery.isLoading}
        isError={sharesQuery.isError}
        itemCount={items.length}
        page={sharesQuery.data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => sharesQuery.refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-4 rounded-md border bg-card p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {s.contractorName ? (
                    <NameDisplay name={s.contractorName} />
                  ) : (
                    <span className="font-mono text-xs" dir="ltr">
                      {t('contractorIdPrefix')} {s.contractorIdShort}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('permissionSummary', { summary: s.permissionSummary })} · {s.createdRelative}
                  {s.lastAccessedRelative && (
                    <> · {t('lastAccessed', { rel: s.lastAccessedRelative })}</>
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onRevoke(s.id)}
                disabled={revokeMutation.isPending}
              >
                {revokeMutation.isPending ? t('revoking') : t('revoke')}
              </Button>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function PermToggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="rounded"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function SubToggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        className="rounded"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
