'use client';

import { ProviderLoginSchema, type ProviderLoginDto } from '@emapp/shared-types';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { apiClient, isOk } from '@/lib/api-client';
import { applyValidationErrors } from '@/lib/errors';

/**
 * Provider Admin login — V10-S2 closure (H1 architectural fix, FE-C).
 *
 * The BE endpoint (`POST /api/v1/provider/auth/login`) requires
 * email + password + 6-digit TOTP code (or a 10-char recovery code,
 * both accepted by `ProviderLoginSchema` — min 6, max 64). MFA is
 * mandatory by D.21; there is NO password-only success path.
 *
 * On 200, the BE sets `provider_access_token` (30 min) + the path-
 * scoped `provider_refresh_token` cookie. The browser stores them at
 * the FE origin (we go through the Pages Function proxy, so the
 * cookies are scoped to the FE host — same posture as the org login).
 *
 * After cookies are set:
 *  - `router.push('/<locale>/provider')` — Provider dashboard home.
 *  - `router.refresh()` — re-runs the middleware (which now sees the
 *    provider cookie) + the dashboard layout (which now resolves the
 *    provider tier).
 *
 * **Anti-enum (Doc 07 §6.12.1)** — every 401 path on the wire returns
 * the same `invalid_credentials` code regardless of:
 *  - unknown email
 *  - wrong password
 *  - wrong MFA code
 *  - disabled account
 *  - locked account (5 wrong → 15 min lock)
 *  - corrupted role in DB
 *
 * The FE collapses all of these into a single localized message. We
 * MUST NOT branch on `error.code` here to give a more helpful
 * message (a future contributor might add "your account is locked,
 * try in 15 min" — that's a credential-state oracle. Don't.).
 *
 * Throttling (429): BE applies `@Throttle({limit: 5, ttl: 10min})`
 * per IP on this endpoint. A 429 surfaces as the same generic
 * message — a brute-force attacker can't distinguish "wrong
 * password" from "rate-limited" through the FE.
 *
 * **§S1-SEC1** — `method="post" action=""` defense in depth against
 * the GET-fallback URL-credential leak. If JS fails to load or the
 * user submits before React hydrates, the browser would otherwise
 * send `?email=...&password=...&mfa_code=...` in the URL (logs, CDN
 * caches, browser history). react-hook-form's `handleSubmit` calls
 * `preventDefault()` on the hydrated path; `method="post"` covers
 * every other path.
 *
 * No `<Link>` to the org login — the provider login is intentionally
 * obscure (operator runbook, not advertised). A "go back" link would
 * just let an attacker who landed here probe whether they're at the
 * provider login by clicking around. Operators navigate via the URL
 * bar.
 */
export default function ProviderLoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProviderLoginDto>({ resolver: zodResolver(ProviderLoginSchema) });

  async function onSubmit(data: ProviderLoginDto) {
    setServerError(null);
    const res = await apiClient.post<{ ok: true }>('/provider/auth/login', data);
    if (isOk(res)) {
      // Cookies are set by the BE Set-Cookie response. Navigate to
      // the provider console; router.refresh() re-runs middleware
      // + the dashboard layout so the new session is resolved.
      router.push('/provider');
      router.refresh();
      return;
    }
    // D.16 — switch on error.code, never on message.
    const code = res.error.code;
    if (code === 'validation_error') {
      const applied = applyValidationErrors(res.error, (field, message) => {
        setError(field as keyof ProviderLoginDto, { type: 'server', message });
      });
      if (applied.length === 0) setServerError(t('invalidProviderCredentials'));
    } else {
      // invalid_credentials / 429 / any other 4xx → same anti-enum
      // message. Defense against credential-state oracles.
      setServerError(t('invalidProviderCredentials'));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">{t('providerLoginTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('providerLoginSubtitle')}</p>
        </div>

        {/* §S1-SEC1 — method="post" defense in depth. */}
        <form
          method="post"
          action=""
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
          dir="rtl"
        >
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="email">
              {t('email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('email')}
            />
            {errors.email && (
              <p className="text-xs text-destructive">
                {errors.email.message ?? t('emailInvalid')}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="password">
              {t('password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="w-full rounded-md border px-3 py-2 text-sm"
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs text-destructive">{errors.password.message ?? t('required')}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="mfa_code">
              {t('mfaCode')}
            </label>
            {/* `dir="ltr"` so the 6-digit TOTP renders left-to-right
                regardless of RTL document direction. `inputMode="numeric"`
                gives the mobile numeric keypad for the common TOTP path;
                the BE also accepts recovery codes (alphanumeric, up to 64
                chars) — the input accepts both because we don't constrain
                the type/pattern here (the schema's min 6 / max 64 covers
                both shapes). `autoComplete="one-time-code"` lets browsers
                offer to auto-fill from the OS-level authenticator app. */}
            <input
              id="mfa_code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={64}
              className="w-full rounded-md border px-3 py-2 font-mono text-sm"
              dir="ltr"
              {...register('mfa_code')}
            />
            {errors.mfa_code && (
              <p className="text-xs text-destructive">
                {errors.mfa_code.message ?? t('mfaCodeInvalid')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('mfaCodeHint')}</p>
          </div>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? t('loggingIn') : t('login')}
          </Button>
        </form>
      </div>
    </div>
  );
}
