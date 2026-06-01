'use client';

import {
  ArrowRight,
  CheckSquare,
  FileSignature,
  Mail,
  MessageCircle,
  Phone,
  StickyNote,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { OwnerPiiReveal } from '@/components/owners/owner-pii-reveal';
import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useArchiveOwner, useOwner } from '@/hooks/use-owners';
import { useSessionProfile } from '@/hooks/use-session';
import { ApiClientError } from '@/lib/api/errors';

/**
 * V11 A.S7 — Owner dossier reskin per
 * `MEAPP_design/screens-projects.jsx` TenantPanel (lines 1694-...).
 *
 * Partner ships TenantPanel as a fixed-position side drawer that slides
 * over the project page. For our app, owners are an org-tier surface
 * with a stable route (`/owners/[id]`); the visual "dossier card" pattern
 * adapts cleanly to a routed page (~vs the drawer overlay). Same
 * identity-card + sectioned-card layout, no router/overlay churn.
 *
 * What changed from the prior detail page:
 *  - Header bar: small "תיק דייר" eyebrow + back link to /owners.
 *  - Identity card (`.card` padded 22px): navy-100 avatar (initials),
 *    name (h1 24px bold), masked PII rows (ID/phone/email) in
 *    monospace LTR for digit alignment, archived chip.
 *  - Contact section as separate card with phone + email icons.
 *  - Quick-actions row (WhatsApp / Send for signature / Add note /
 *    Create task) — all 4 disabled with `actionsComingSoon` hint.
 *    These need wire enrichment (phone-to-WhatsApp, document picker,
 *    note creation, task creation endpoints).
 *  - Notes section preserved (the only piece of writable per-owner
 *    metadata the wire exposes today).
 *  - Archive action preserved verbatim — `useArchiveOwner` flow,
 *    window.confirm, router.push back to /owners on success.
 *
 * PII discipline preserved: `nationalIdMasked` + `phoneMasked` rendered
 * as the wire ships them (never cleartext); `<NameDisplay>` wraps every
 * user-supplied name; archive flow uses anti-enumeration generic error
 * `t('archiveFailed')` regardless of underlying cause.
 */
export default function OwnerDetailPage() {
  const t = useTranslations('owners');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useOwner(id);
  const archive = useArchiveOwner();
  const { data: profile } = useSessionProfile();
  const [actionError, setActionError] = useState<string | null>(null);
  // D.54 — offer the reveal button only to roles that can ever hold
  // view_owner_pii: manager (always) + agent (per-flag, gated server-side).
  // Viewers never reveal, so they don't see the button. The BE is the
  // authoritative gate regardless of this UX hint.
  const canReveal = profile?.role === 'manager' || profile?.role === 'agent';

  if (isLoading) return <ListSkeleton withRows={false} />;
  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {notFound ? t('notFound') : t('loadFailed')}
        </p>
        <Button variant="outline" size="sm" onClick={() => router.push('/owners')}>
          {tp('backToList')}
        </Button>
      </div>
    );
  }
  if (!data) return null;

  async function onArchive() {
    if (!id) return;
    setActionError(null);
    if (!window.confirm(t('archiveConfirm'))) return;
    try {
      await archive.mutateAsync(id);
      router.push('/owners');
    } catch {
      // Anti-enumeration generic — same UX whether RBAC, network, or BE failed.
      setActionError(t('archiveFailed'));
    }
  }

  // Initials helper — Hebrew names: first letter of first two whitespace
  // tokens; single-word fallback to first 2 chars.
  function initialsOf(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0]![0] ?? '') + (parts[1]![0] ?? '');
    return name.slice(0, 2);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* Header bar — eyebrow + back link */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          {t('dossier')}
        </span>
        <Link
          href="/owners"
          className="flex items-center gap-1 text-sm hover:underline"
          style={{ color: 'var(--navy-700)' }}
        >
          <ArrowRight className="h-3.5 w-3.5 rotate-180" aria-hidden="true" />
          <span>{tp('backToList')}</span>
        </Link>
      </div>

      {/* Identity card */}
      <div className="card" style={{ padding: 22 }}>
        <div className="flex items-start gap-4">
          <div
            className="avatar avatar-xl"
            style={{ background: 'var(--navy-100)', color: 'var(--navy-900)' }}
            aria-hidden="true"
          >
            {initialsOf(data.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1
                className="truncate text-2xl font-bold"
                style={{ color: 'var(--text)', lineHeight: 1.2 }}
              >
                <NameDisplay name={data.name} />
              </h1>
              {data.isArchived && (
                <span className="badge badge-neutral">
                  <span className="badge-dot" aria-hidden="true" />
                  <span>{tp('archived')}</span>
                </span>
              )}
              {!data.isArchived && (
                <div className="ms-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onArchive}
                    disabled={archive.isPending}
                  >
                    {archive.isPending ? tp('archiving') : tp('archive')}
                  </Button>
                </div>
              )}
            </div>

            {/* Masked PII + D.54 reveal-on-demand — LTR for digit alignment. */}
            <div className="mt-3">
              <OwnerPiiReveal
                ownerId={data.id}
                nationalIdMasked={data.nationalIdMasked}
                phoneMasked={data.phoneMasked}
                canReveal={canReveal}
                idLabel={t('idLabel')}
                phoneLabel={t('phoneLabel')}
              />
              {data.email && (
                <dl
                  className="tabular mt-1.5 grid grid-cols-[80px_1fr] gap-y-1.5 text-sm"
                  style={{ color: 'var(--text)' }}
                  dir="ltr"
                >
                  <dt style={{ color: 'var(--text-muted)' }}>{t('emailLabel')}</dt>
                  <dd className="break-all">
                    <NameDisplay name={data.email} />
                  </dd>
                </dl>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Contact section (icon-row variant of the masked PII for visual
       *  parity with the partner TenantPanel `EditableRow` pattern). */}
      {(data.phoneMasked || data.email) && (
        <section className="card card-pad flex flex-col gap-2" aria-labelledby="own-contact-h">
          <h2
            id="own-contact-h"
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {t('contactSection')}
          </h2>
          {data.phoneMasked && (
            <div className="flex items-center gap-2.5 text-sm">
              <Phone
                className="h-4 w-4 shrink-0"
                style={{ color: 'var(--text-soft)' }}
                aria-hidden="true"
              />
              <span style={{ color: 'var(--text-muted)' }}>{t('phoneLabel')}</span>
              <span className="tabular" dir="ltr" style={{ color: 'var(--text)' }}>
                {data.phoneMasked}
              </span>
            </div>
          )}
          {data.email && (
            <div className="flex items-center gap-2.5 text-sm">
              <Mail
                className="h-4 w-4 shrink-0"
                style={{ color: 'var(--text-soft)' }}
                aria-hidden="true"
              />
              <span style={{ color: 'var(--text-muted)' }}>{t('emailLabel')}</span>
              <span className="break-all" dir="ltr" style={{ color: 'var(--text)' }}>
                <NameDisplay name={data.email} />
              </span>
            </div>
          )}
        </section>
      )}

      {/* Quick-actions row (all disabled — placeholder per `actionsComingSoon`) */}
      <section className="card card-pad flex flex-col gap-3" aria-labelledby="own-actions-h">
        <h2
          id="own-actions-h"
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          {t('actionsSection')}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title={t('actionsComingSoon')}
            className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('actionWhatsapp')}</span>
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            title={t('actionsComingSoon')}
            className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileSignature className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('actionSendDoc')}</span>
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            title={t('actionsComingSoon')}
            className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <StickyNote className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('actionAddNote')}</span>
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            title={t('actionsComingSoon')}
            className="btn btn-secondary btn-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('actionCreateTask')}</span>
          </button>
        </div>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {t('actionsComingSoon')}
        </p>
      </section>

      {/* Notes — only piece of writable per-owner metadata the wire exposes */}
      {data.notes && (
        <section className="card card-pad" aria-labelledby="own-notes-h">
          <h2
            id="own-notes-h"
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {t('field.notes')}
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm" style={{ color: 'var(--text)' }}>
            <NameDisplay name={data.notes} />
          </p>
        </section>
      )}

      {actionError && (
        <p className="text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
          {actionError}
        </p>
      )}
    </div>
  );
}
