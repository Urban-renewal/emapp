'use client';

import type { MemberPermissionOverride, OverrideEffect } from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { useToast } from '@/components/ui/action-toast';
import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import {
  useClearMemberOverride,
  useMemberOverrides,
  useSetMemberOverride,
} from '@/hooks/use-members';
import { usePermissions } from '@/hooks/use-permissions';
import type { MemberViewModel } from '@/models/member.vm';

/**
 * P2 Phase 2 — per-user permission OVERRIDES editor (Owner/Admin only).
 *
 * Lets an Owner/Admin layer a `grant` (ADD) or `deny` (REMOVE) of a single
 * catalog permission on top of a member's role-derived set, at ORG scope (the
 * common case; project-scope overrides are a BE capability surfaced later).
 *
 * GATING — this panel is rendered ONLY when the actor holds `roles.manage`
 * (the parent passes `visible`); the BE re-checks `roles.manage` + the
 * anti-escalation (a GRANT must be ⊆ the grantor's own perms; org./roles.
 * are Owner-only) + the last-Owner DENY guard. This UI is defense-in-depth UX,
 * not the authority.
 *
 * The selectable permission list is the ACTOR's OWN effective permission set
 * (`usePermissions()` from /me): you can only grant what you hold (matches the
 * BE anti-escalation), and denying a permission the member could plausibly hold
 * is drawn from the same surface. The BE is the authoritative validator —
 * an out-of-bounds choice returns a typed error we surface inline.
 */
interface Props {
  member: MemberViewModel;
  /** True only when the current actor holds `roles.manage`. */
  visible: boolean;
}

export function MemberOverridesPanel({ member, visible }: Props) {
  const t = useTranslations('members.overrides');
  const { permissions } = usePermissions();
  const { data: overrides, isLoading } = useMemberOverrides(member.userId, visible);
  const setMutation = useSetMemberOverride(member.userId);
  const clearMutation = useClearMemberOverride(member.userId);
  const toast = useToast();

  const [permission, setPermission] = useState('');
  const [effect, setEffect] = useState<OverrideEffect>('grant');

  // The actor's grantable surface (sorted for a stable list).
  const grantable = useMemo(() => [...permissions].sort(), [permissions]);

  const { serverError, handle, reset } = useApiErrorHandler({
    codeOverrides: {
      override_escalation: () => t('err.escalation'),
      override_owner_tier_only: () => t('err.ownerTierOnly'),
      cannot_strip_last_owner: () => t('err.lastOwner'),
      unknown_permission: () => t('err.unknownPermission'),
      cannot_modify_self: () => t('err.self'),
      forbidden: () => t('err.forbidden'),
    },
    fallback: () => t('err.saveFailed'),
  });

  // Don't render anything for non-authorized actors (the parent also gates,
  // but this is the component-level guard).
  if (!visible) return null;

  async function onSet() {
    if (!permission) return;
    reset();
    const applied = { permission, effect };
    try {
      await setMutation.mutateAsync({ permission, effect, scopeType: 'org' });
      setPermission('');
      // M0+G6 — instant + undo (the inverse is a single clear of what we set).
      toast.show({
        message: t('added'),
        undo: {
          label: t('undo'),
          onUndo: async () => {
            try {
              await clearMutation.mutateAsync({ permission: applied.permission, scopeType: 'org' });
            } catch {
              // Undo is best-effort; the override list reflects the real state.
            }
          },
        },
      });
    } catch (e) {
      handle(e);
    }
  }

  async function onClear(o: MemberPermissionOverride) {
    reset();
    try {
      await clearMutation.mutateAsync({
        permission: o.permission,
        scopeType: o.scopeType,
        ...(o.scopeType === 'project' ? { scopeId: o.scopeId } : {}),
      });
      // Undo re-applies the cleared override (org-scope inverse).
      toast.show({
        message: t('cleared'),
        undo:
          o.scopeType === 'org'
            ? {
                label: t('undo'),
                onUndo: async () => {
                  try {
                    await setMutation.mutateAsync({
                      permission: o.permission,
                      effect: o.effect,
                      scopeType: 'org',
                    });
                  } catch {
                    // Best-effort undo; the override list reflects real state.
                  }
                },
              }
            : undefined,
      });
    } catch (e) {
      handle(e);
    }
  }

  const disabled = member.isRevoked || setMutation.isPending;
  const orgOverrides = (overrides ?? []).filter((o) => o.scopeType === 'org');

  return (
    <div className="rounded-md border bg-card p-4">
      <h2 className="mb-1 text-base font-semibold">{t('title')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{t('hint')}</p>

      {/* Existing override layer. */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : orgOverrides.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="mb-3 space-y-2">
          {orgOverrides.map((o) => (
            <li
              key={o.id}
              className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <span
                  className={o.effect === 'grant' ? 'badge badge-success' : 'badge badge-danger'}
                >
                  {o.effect === 'grant' ? t('effect.grant') : t('effect.deny')}
                </span>
                <code dir="ltr" className="font-mono text-xs">
                  {o.permission}
                </code>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={member.isRevoked || clearMutation.isPending}
                onClick={() => onClear(o)}
              >
                {t('clear')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Add an override. §S1-SEC1 — method="post" defense in depth. */}
      <form
        method="post"
        action=""
        onSubmit={(e) => {
          e.preventDefault();
          void onSet();
        }}
        className="space-y-3 border-t pt-3"
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <select
            aria-label={t('field.permission')}
            disabled={disabled}
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
            dir="ltr"
          >
            <option value="">{t('field.permissionPlaceholder')}</option>
            {grantable.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            aria-label={t('field.effect')}
            disabled={disabled}
            value={effect}
            onChange={(e) => setEffect(e.target.value as OverrideEffect)}
            className="rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="grant">{t('effect.grant')}</option>
            <option value="deny">{t('effect.deny')}</option>
          </select>
          <Button type="submit" disabled={disabled || !permission}>
            {setMutation.isPending ? t('saving') : t('add')}
          </Button>
        </div>
        {serverError && <p className="text-sm text-destructive">{serverError}</p>}
      </form>
    </div>
  );
}
