'use client';

import { LoginSchema, type LoginDto } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

/**
 * V11 A.S1 PR-2 — Login reskin per
 * `MEAPP_design/design_handoff/source/screens-manager.jsx`. Split-screen:
 * navy gradient brand panel on the right (RTL flex first child) +
 * 480px form panel on the left.
 *
 * Wired roles in MVP:
 *   - Manager: email + password through `apiClient.post('/auth/login')`
 *   - Agent / Contractor / Tenant: visible-but-disabled with tooltip
 *     (D.20 — Tenant lives behind SMS OTP; Contractor lives behind a
 *     share-link; Agent flow follows Manager in a later slice).
 *
 * The auth flow is identical to pre-reskin: `method="post"` +
 * `action=""` (defense in depth per PR #47 + #61), `handleSubmit`
 * (preventDefault on hydrated path), `apiClient.post` (D.35 same-origin
 * /api/v1/* proxy), `applyValidationErrors` for `validation_error` ->
 * field errors, anti-enumeration generic message for everything else.
 */

type RoleId = 'manager' | 'agent' | 'contractor' | 'tenant';
const WIRED_ROLE: RoleId = 'manager';

export default function LoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<RoleId>(WIRED_ROLE);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginDto>({ resolver: zodResolver(LoginSchema) });

  async function onSubmit(data: LoginDto) {
    setServerError(null);
    const res = await apiClient.post<{ user: object }>('/auth/login', data);
    if (isOk(res)) {
      router.push('/');
      router.refresh();
      return;
    }
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        setError(field as keyof LoginDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('invalidCredentials'));
    } else {
      setServerError(t('invalidCredentials'));
    }
  }

  const roles: ReadonlyArray<{
    id: RoleId;
    label: string;
    sub: string;
    wired: boolean;
    comingSoon?: string;
  }> = [
    {
      id: 'manager',
      label: t('rolePicker.manager.label'),
      sub: t('rolePicker.manager.sub'),
      wired: true,
    },
    {
      id: 'agent',
      label: t('rolePicker.agent.label'),
      sub: t('rolePicker.agent.sub'),
      wired: false,
      comingSoon: t('rolePicker.comingSoonAgent'),
    },
    {
      id: 'contractor',
      label: t('rolePicker.contractor.label'),
      sub: t('rolePicker.contractor.sub'),
      wired: false,
      comingSoon: t('rolePicker.comingSoonContractor'),
    },
    {
      id: 'tenant',
      label: t('rolePicker.tenant.label'),
      sub: t('rolePicker.tenant.sub'),
      wired: false,
      comingSoon: t('rolePicker.comingSoonTenant'),
    },
  ];

  return (
    <div className="flex min-h-screen">
      {/* Brand panel — first in HTML order, renders on the right under
       *  RTL flex (matches handoff screenshot 01-login.png). */}
      <div
        className="relative flex flex-1 flex-col justify-between overflow-hidden p-12 text-white"
        style={{ background: 'linear-gradient(160deg, var(--navy-900) 0%, var(--navy-700) 100%)' }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 80% 20%, rgba(255,255,255,.06), transparent 50%), radial-gradient(circle at 20% 80%, rgba(255,255,255,.04), transparent 50%)',
          }}
        />
        <div className="relative z-10 flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-[10px] text-sm font-bold tracking-wider"
            style={{ background: 'rgba(255,255,255,.12)' }}
          >
            EM
          </div>
          <div className="text-xl font-semibold">EMAPP</div>
        </div>
        <div className="relative z-10 max-w-[460px]">
          <h1 className="mb-4 text-[38px] font-bold leading-[1.15]">{t('brandHeadline')}</h1>
          <p className="text-[15px] leading-[1.6]" style={{ color: 'rgba(255,255,255,.75)' }}>
            {t('brandSubtitle')}
          </p>
        </div>
        <div className="relative z-10 text-xs" style={{ color: 'rgba(255,255,255,.5)' }}>
          {t('brandCopyright')}
        </div>
      </div>

      {/* Form panel — 480px wide, renders on the left under RTL flex. */}
      <div className="flex w-[480px] flex-col justify-center px-14 py-16">
        <div className="mb-7">
          <div className="mb-1.5 text-2xl font-bold">{t('formHeading')}</div>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('formSubheading')}
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-2">
          {roles.map((r) => {
            const active = r.id === activeRole;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => r.wired && setActiveRole(r.id)}
                disabled={!r.wired}
                title={r.comingSoon}
                aria-label={r.comingSoon ? `${r.label} — ${r.comingSoon}` : r.label}
                className="rounded-[10px] p-3.5 text-right transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  background: active ? 'var(--navy-50)' : 'var(--bg-surface)',
                  border: `1.5px solid ${active ? 'var(--primary-partner)' : 'var(--border-strong)'}`,
                }}
              >
                <div
                  className="text-sm font-semibold"
                  style={{ color: active ? 'var(--navy-900)' : 'var(--text)' }}
                >
                  {r.label}
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {r.sub}
                </div>
              </button>
            );
          })}
        </div>

        <form
          method="post"
          action=""
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <div>
            <label className="label" htmlFor="email">
              {t('email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="input"
              dir="ltr"
              {...register('email')}
            />
            {errors.email && (
              <p className="mt-1 text-xs" style={{ color: 'var(--danger-700)' }}>
                {errors.email.message ?? t('emailInvalid')}
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="password">
              {t('password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="input"
              dir="ltr"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs" style={{ color: 'var(--danger-700)' }}>
                {errors.password.message ?? t('required')}
              </p>
            )}
          </div>

          {serverError && (
            <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
              {serverError}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-primary btn-lg w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? t('loggingIn') : t('loginCta')}
          </button>
        </form>

        <p className="mt-5 text-center text-sm">
          {t('noAccount')}{' '}
          <Link
            href="/signup"
            className="font-medium underline"
            style={{ color: 'var(--navy-700)' }}
          >
            {t('signup')}
          </Link>
        </p>
      </div>
    </div>
  );
}
