'use client';

import {
  OrgRoleEnum,
  UpdateMemberInput,
  type OrgRole,
  type UpdateMember,
} from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { use, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { MemberCapabilitiesPanel } from '@/components/members/member-capabilities-panel';
import { MemberOverridesPanel } from '@/components/members/member-overrides-panel';
import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import {
  useMember,
  useResendInvite,
  useRevokeMember,
  useUpdateMemberRole,
} from '@/hooks/use-members';
import { useHasPermission } from '@/hooks/use-permissions';
import { ApiClientError } from '@/lib/api/errors';

interface PageProps {
  params: Promise<{ userId: string }>;
}

/**
 * Member detail / role-change / revoke page (Manager-only).
 *
 * The BE has no `GET /members/:id` — the list response carries every
 * field we need. `useMember` is a thin lookup on the list cache; for
 * any userId the Manager navigates to from the list view, the row is
 * already cached.
 *
 * Defenses:
 *  - `cannot_modify_self` 400 (BE refuses self-role-change) maps to a
 *    UI-visible message; we ALSO hide the Save button when the userId
 *    matches the current session's `sub` (cosmetic — but the user
 *    profile isn't available client-side, so the BE error is the
 *    authoritative gate).
 *  - `cannot_remove_last_manager` 400 maps to a UI-visible message;
 *    we keep the Save button enabled because the Manager may not know
 *    they're the last (the BE message is the truth source).
 *  - Revoked rows: Save + Revoke buttons disabled; the row is
 *    forensic-only (cannot transition out of revoked).
 *  - Primary member: Revoke is disabled (BE also refuses).
 */
export default function MemberDetailPage({ params }: PageProps) {
  const { userId } = use(params);
  const t = useTranslations('members');
  // Reuse nav.role (single source of truth for the OrgRole label set;
  // also used by the topbar — `_components/topbar.tsx`).
  const trl = useTranslations('nav.role');
  const locale = useLocale();
  const router = useRouter();
  const { data: member, isLoading, isError } = useMember(userId, { limit: 100 });
  const updateMutation = useUpdateMemberRole();
  const revokeMutation = useRevokeMember();
  const resendMutation = useResendInvite();
  // members.invite gates both invite AND resend (same BE permission).
  const canInvite = useHasPermission('members.invite');

  // Invite-recovery state (pending members only). The resend response
  // may carry a one-shot inviteToken in non-prod (D.27); we hold it in
  // component state to rebuild the accept-invite link — never persisted
  // to TanStack cache.
  const [resendMsg, setResendMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // P2 Phase 2 — the per-user override panel is Owner/Admin only (roles.manage).
  const canManageRoles = useHasPermission('roles.manage');

  const {
    register,
    handleSubmit,
    setError,
    reset: resetForm,
    formState: { errors, isSubmitting },
  } = useForm<UpdateMember>({
    resolver: zodResolver(UpdateMemberInput),
    defaultValues: { role: member?.role ?? 'agent' },
  });

  // Re-seed the form when the cache lookup completes.
  useEffect(() => {
    if (member?.role) resetForm({ role: member.role });
  }, [member?.role, resetForm]);

  const { serverError, handle, reset } = useApiErrorHandler<UpdateMember>({
    setError,
    codeOverrides: {
      cannot_modify_self: () => t('cannotModifySelf'),
      cannot_remove_last_manager: () => t('cannotRemoveLastManager'),
    },
    fallback: () => t('updateFailed'),
  });

  const revokeError = useApiErrorHandler<UpdateMember>({
    codeOverrides: {
      cannot_modify_self: () => t('cannotModifySelf'),
      cannot_remove_last_manager: () => t('cannotRemoveLastManager'),
    },
    fallback: () => t('revokeFailed'),
  });

  async function onSubmit(values: UpdateMember) {
    if (!userId) return;
    reset();
    try {
      await updateMutation.mutateAsync({ userId, body: values });
    } catch (e) {
      handle(e);
    }
  }

  async function onRevoke() {
    if (!userId) return;
    if (!confirm(t('revokeConfirm'))) return;
    revokeError.reset();
    try {
      await revokeMutation.mutateAsync(userId);
      router.push('/members');
    } catch (e) {
      revokeError.handle(e);
    }
  }

  /** Re-issue the invite (re-sends the email). In non-prod the response
   *  carries the one-shot token, which we keep so the Manager can copy
   *  the accept-invite link when email didn't arrive (FakeEmail in dev). */
  async function onResend() {
    if (!userId) return;
    setResendMsg(null);
    setLinkCopied(false);
    try {
      const result = await resendMutation.mutateAsync(userId);
      setInviteToken(result.inviteToken ?? null);
      setResendMsg({ kind: 'ok', text: t('resendOk') });
    } catch (e) {
      const code = e instanceof ApiClientError ? e.code : null;
      const text =
        code === 'member_not_pending'
          ? t('resendNotPending')
          : code === 'not_found'
            ? t('notFound')
            : t('resendFailed');
      setResendMsg({ kind: 'err', text });
    }
  }

  /** Build `/<locale>/accept-invite/<token>` (path-style, mirrors the
   *  BE inviteUrl + the /members/new success screen) and copy it. */
  async function copyInviteLink() {
    if (!inviteToken) return;
    const url = `${window.location.origin}/${locale}/accept-invite/${encodeURIComponent(
      inviteToken,
    )}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard API can fail in non-secure contexts / under permission
      // denial — swallow; the Manager can still copy from the visible field.
    }
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  }
  if (isError || !member) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('notFound')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/members')}>
          {t('backToList')}
        </Button>
      </div>
    );
  }

  const canRevoke = !member.isRevoked && !member.isPrimary;
  const canEditRole = !member.isRevoked;

  return (
    <div className="mx-auto max-w-2xl space-y-6" dir="rtl">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="truncate text-2xl font-bold">
            <NameDisplay name={member.name} />
          </h1>
          <p className="text-sm text-muted-foreground">
            <NameDisplay name={member.email} />
          </p>
          <div className="flex items-center gap-2">
            <StatusBadge color={member.stateColor}>{member.stateLabel}</StatusBadge>
            {member.isPrimary && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                {t('primary')}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" onClick={() => router.push('/members')}>
          {t('backToList')}
        </Button>
      </div>

      {/* Slice 2 — invite recovery for a PENDING member: re-send the
          email and (in dev, when the token comes back) copy the
          accept-invite link. members.invite gates both actions. */}
      {member.isPending && canInvite && (
        <div className="rounded-md border bg-amber-50 p-4">
          <h2 className="mb-1 text-base font-semibold text-amber-900">{t('inviteRecovery')}</h2>
          <p className="mb-3 text-xs text-amber-800">{t('inviteRecoveryHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onResend}
              disabled={resendMutation.isPending}
            >
              {resendMutation.isPending ? t('resending') : t('resend')}
            </Button>
            {inviteToken && (
              <Button type="button" variant="outline" size="sm" onClick={copyInviteLink}>
                {linkCopied ? t('copied') : t('copyLink')}
              </Button>
            )}
          </div>
          {resendMsg && (
            <p
              className={`mt-2 text-sm ${
                resendMsg.kind === 'ok' ? 'text-emerald-700' : 'text-destructive'
              }`}
            >
              {resendMsg.text}
            </p>
          )}
          {inviteToken && <p className="mt-2 text-xs text-amber-700">{t('inviteTokenWarning')}</p>}
        </div>
      )}

      <div className="rounded-md border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">{t('roleSection')}</h2>
        {/* §S1-SEC1 — method="post" defense in depth. */}
        <form method="post" action="" onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="role" className="text-sm font-medium">
              {t('field.role')}
            </label>
            <select
              id="role"
              disabled={!canEditRole}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
              {...register('role')}
            >
              {OrgRoleEnum.options.map((r: OrgRole) => (
                <option key={r} value={r} dir="auto">
                  {trl(r)}
                </option>
              ))}
            </select>
            {errors.role && <p className="text-xs text-destructive">{errors.role.message}</p>}
          </div>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <div className="flex items-center justify-end">
            <Button type="submit" disabled={!canEditRole || isSubmitting}>
              {isSubmitting ? t('saving') : t('save')}
            </Button>
          </div>
        </form>
      </div>

      {/* D.46/D.54 — agent capability matrix (role-presets + toggles). */}
      <MemberCapabilitiesPanel member={member} />

      {/* P2 Phase 2 — per-user permission overrides (Owner/Admin only). */}
      <MemberOverridesPanel member={member} visible={canManageRoles} />

      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
        <h2 className="mb-2 text-base font-semibold text-destructive">{t('revokeSection')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('revokeHint')}</p>
        {revokeError.serverError && (
          <p className="mb-2 text-sm text-destructive">{revokeError.serverError}</p>
        )}
        <Button
          type="button"
          variant="destructive"
          disabled={!canRevoke || revokeMutation.isPending}
          onClick={onRevoke}
        >
          {revokeMutation.isPending ? t('revoking') : t('revoke')}
        </Button>
      </div>
    </div>
  );
}
