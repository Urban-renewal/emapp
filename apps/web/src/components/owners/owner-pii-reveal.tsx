'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useRevealOwnerPii } from '@/hooks/use-owners';
import { ApiClientError } from '@/lib/api/errors';

/**
 * D.54 — "Reveal PII" control for the owner dossier.
 *
 * Shows the masked national_id / phone by default. On an explicit click it
 * calls POST /owners/:id/reveal-pii (BE-audited `owner.pii_revealed`) and
 * displays the CLEARTEXT transiently. The BE is the sole authority on
 * whether the actor may reveal (manager always · agent with view_owner_pii
 * · viewer never → 403); the button is only OFFERED to manager/agent as a
 * UX nicety (viewers don't see it).
 *
 * SECURITY (CLAUDE.md / D.54):
 *  - The cleartext lives in EPHEMERAL component state only — never the
 *    TanStack cache, never localStorage, never the URL, never a log.
 *  - It is cleared when the owner changes (navigation) and on "hide".
 *  - The reveal is POST (id never in a query string / history).
 */
interface Props {
  ownerId: string;
  nationalIdMasked: string;
  phoneMasked: string | null;
  /** Show the reveal button at all (manager/agent only — viewers never). */
  canReveal: boolean;
  idLabel: string;
  phoneLabel: string;
}

export function OwnerPiiReveal({
  ownerId,
  nationalIdMasked,
  phoneMasked,
  canReveal,
  idLabel,
  phoneLabel,
}: Props) {
  const t = useTranslations('owners.reveal');
  const reveal = useRevealOwnerPii();
  // Cleartext held ONLY here; never persisted/cached/logged.
  const [clear, setClear] = useState<{ nationalId: string; phone: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Drop any revealed cleartext if the owner changes (navigation / cache swap).
  useEffect(() => {
    setClear(null);
    setError(null);
  }, [ownerId]);

  async function onReveal() {
    setError(null);
    try {
      const r = await reveal.mutateAsync(ownerId);
      // A shell owner has no national_id to reveal — show a neutral placeholder.
      setClear({ nationalId: r.nationalId ?? '—', phone: r.phone });
    } catch (e) {
      // Anti-enumeration: 403 (no permission) and any other failure surface
      // the SAME generic message — never reveal which gate blocked.
      const code = e instanceof ApiClientError ? e.code : undefined;
      setError(code === 'forbidden' ? t('noPermission') : t('failed'));
    }
  }

  function onHide() {
    setClear(null);
  }

  const revealed = clear !== null;

  return (
    <div className="space-y-1.5">
      <dl
        className="tabular grid grid-cols-[80px_1fr] gap-y-1.5 text-sm"
        style={{ color: 'var(--text)' }}
        dir="ltr"
      >
        <dt style={{ color: 'var(--text-muted)' }}>{idLabel}</dt>
        <dd>{revealed ? clear!.nationalId : nationalIdMasked}</dd>
        {phoneMasked && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>{phoneLabel}</dt>
            {/* When revealed, show the cleartext phone the BE returned (may be
                null if none on file even though a mask existed historically). */}
            <dd>{revealed ? (clear!.phone ?? phoneMasked) : phoneMasked}</dd>
          </>
        )}
      </dl>

      {canReveal && (
        <div className="flex items-center gap-2" dir="rtl">
          {!revealed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reveal.isPending}
              onClick={onReveal}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{reveal.isPending ? t('revealing') : t('reveal')}</span>
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={onHide}>
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('hide')}</span>
            </Button>
          )}
          {revealed && <span className="text-xs text-amber-700">{t('revealedHint')}</span>}
        </div>
      )}

      {error && (
        <p className="text-xs" style={{ color: 'var(--danger-700)' }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
