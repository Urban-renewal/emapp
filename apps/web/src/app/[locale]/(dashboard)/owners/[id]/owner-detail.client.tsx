'use client';

import { ArrowRight, Mail, Phone } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { OwnerPiiReveal } from '@/components/owners/owner-pii-reveal';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useArchiveOwner, useOwner, useOwnerProjects } from '@/hooks/use-owners';
import { useHasPermission } from '@/hooks/use-permissions';
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
 *    styled `useConfirm()` dialog, router.push back to /owners on success.
 *
 * PII discipline preserved: `nationalIdMasked` + `phoneMasked` rendered
 * as the wire ships them (never cleartext); `<NameDisplay>` wraps every
 * user-supplied name; archive flow uses anti-enumeration generic error
 * `t('archiveFailed')` regardless of underlying cause.
 */
export function OwnerDetailClient() {
  const t = useTranslations('owners');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useOwner(id);
  // S3d — the projects this owner is tied to (via active ownerships). BE
  // org/agent-scopes the list; the response carries projects only, no PII.
  const { data: projects } = useOwnerProjects(id);
  const archive = useArchiveOwner();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [actionError, setActionError] = useState<string | null>(null);
  // PII reveal authority. The BE reveal endpoint (`resolveOwnerPiiFidelity`)
  // gates on the LEGACY capability model — manager always · agent iff its
  // `view_owner_pii` capability is granted · viewer never — NOT the engine
  // `owners.reveal_pii` role-permission. `/me` exposes `view_owner_pii`
  // computed by that EXACT same logic, so we gate the button on it → FE === BE.
  // (Gating on `useHasPermission('owners.reveal_pii')` was a split-brain: it
  // HID the button from an agent the org granted PII access to via the
  // capabilities panel — the engine agent role excludes reveal_pii and no
  // per-assignment grant path exists yet. When reveal_pii migrates to a
  // per-assignment engine grant, `/me.view_owner_pii` moves with the BE gate,
  // so this stays correct.) The BE endpoint is the authoritative gate regardless.
  const { data: profile } = useSessionProfile();
  const canReveal = profile?.view_owner_pii === true;
  // Archive is a write — gate the "ארכוב" button on `owners.archive`.
  const canArchive = useHasPermission('owners.archive');

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
    if (!(await confirm({ message: t('archiveConfirm'), destructive: true }))) return;
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
              {!data.isArchived && canArchive && (
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

      {/* S3d — Projects the owner is tied to (via active ownerships). Rendered
       *  only when there is at least one — an owner with no active ownership
       *  shows nothing (the BE returns []). Each row links to the project. */}
      {projects && projects.length > 0 && (
        <section className="card card-pad" aria-labelledby="own-projects-h">
          <h2
            id="own-projects-h"
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {t('projectsSection')}
          </h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:underline"
                  style={{ color: 'var(--text)' }}
                >
                  <span className="min-w-0 truncate">
                    <NameDisplay name={p.name} />
                    <span className="ms-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {p.typeLabel}
                    </span>
                  </span>
                  <StatusBadge color={p.statusColor}>{p.statusLabel}</StatusBadge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* IAM slice 5b — the owner quick-actions row (WhatsApp / send-for-
       *  signature / add-note / create-task) was a placeholder: all four were
       *  permanently `disabled` because the wire (phone-to-WhatsApp, document
       *  picker, note/task creation endpoints) isn't built. Ship-or-hide: a
       *  dead control is a dead control whatever its role gate, so the whole
       *  section is removed until the endpoints exist. Re-add behind the
       *  matching write permission (`tasks.create`, `signature_requests.send`,
       *  `notes.create`) when wired. */}

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
      {confirmDialog}
    </div>
  );
}
