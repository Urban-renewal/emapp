'use client';

import { Building2, FileSignature, ListChecks } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useArchiveProject, useProject } from '@/hooks/use-projects';
import { ApiClientError } from '@/lib/api/errors';
import type { ProjectViewModel } from '@/models/project.vm';

import { ExportXlsxButton } from './_components/export-xlsx-button';
import { ParcelSetupSection } from './_components/parcel-setup-section';
import { ProjectDocumentUpload } from './_components/project-document-upload';
import { SignatureCampaignAction } from './_components/signature-campaign-action';
import { SignatureProgressApartments } from './_components/signature-progress-apartments';
import { SignatureProgressBar } from './_components/signature-progress-bar';
import { SignatureProgressBoard } from './_components/signature-progress-board';

type TabId = 'tenants' | 'docs' | 'tasks' | 'dashboard';

/**
 * V11 A.S5 — ProjectPage reskin per
 * `MEAPP_design/screens-projects.jsx` ProjectPage (lines 637-...).
 *
 * Layout:
 *  - Header card (`.card .card-pad`): navy-50 building-icon block +
 *    project name + StatusBadge + (Excel/PDF placeholder action
 *    buttons disabled per `home.action.fieldTaskHint` pattern) +
 *    meta line (type · createdRelative + archived chip if archived)
 *    + 3-col KPI grid placeholder (contractor / signatures / agents,
 *    all `—` until BE wire enrichment).
 *  - Tabs nav (`.card overflow-hidden`): 4 tabs per partner ProjectPage
 *    lines 911-915 — Tenants / Docs+Messages / Tasks / Dashboard.
 *    Active tab gets `aria-selected="true"` + navy-900 bottom border;
 *    inactive tabs use `text-muted` color.
 *  - Tab content panels:
 *     • דיירים → CTA card linking to `/projects/[id]/buildings` (the
 *       existing per-project building/apartment management surface);
 *       the partner design embeds a tenant table here but the org-tier
 *       wire doesn't expose a per-project tenant aggregator today.
 *     • מסמכים והודעות → empty-state with CTAs to `/documents` and
 *       `/signature-requests`. Docs are org-wide; sigs are
 *       per-project but the per-project filter is a future BE slice.
 *     • משימות → empty-state pointing to `/tasks` (existing global
 *       list). Per-project task scoping wires up in A.S12.
 *     • לוח בקרה → keeps the previous detail content (description
 *       + buildings/assignments/shares CTAs + archive action).
 *       Acts as the home of "Project Details" until a richer dashboard
 *       per `project-dashboard.jsx` lands in a polish slice.
 *
 * Routing / interactions preserved:
 *  - Buildings / Assignments / Shares links unchanged.
 *  - Archive flow unchanged (window.confirm + mutateAsync + router push).
 *  - StatusBadge / NameDisplay / Button components untouched.
 */
export default function ProjectDetailPage() {
  const t = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useProject(id);
  const archive = useArchiveProject();
  // IAM slice 5b — permission gates (UX; BE is authoritative).
  const canArchive = useHasPermission('projects.archive');
  const canExport = useHasPermission('export.run');
  // P3c — the parcel-setup confirm materializes buildings + apartments, so
  // the affordance gates on buildings.create (UX; BE is authoritative).
  const canCreateBuildings = useHasPermission('buildings.create');
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('tenants');

  if (isLoading) return <ListSkeleton withRows={false} />;

  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {notFound ? t('notFound') : t('loadFailed')}
        </p>
        <Button variant="outline" size="sm" onClick={() => router.push('/projects')}>
          {t('backToList')}
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
      router.push('/projects');
    } catch (e) {
      // Both ApiClientError + generic Error collapse to the same UX:
      // anti-enumeration generic "archive failed" message.
      if (e instanceof ApiClientError) {
        setActionError(t('archiveFailed'));
      } else {
        setActionError(t('archiveFailed'));
      }
    }
  }

  const tabs: ReadonlyArray<{ id: TabId; label: string }> = [
    { id: 'tenants', label: t('tab.tenants') },
    { id: 'docs', label: t('tab.docs') },
    { id: 'tasks', label: t('tab.tasks') },
    { id: 'dashboard', label: t('tab.dashboard') },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Header card */}
      <div className="card" style={{ padding: 22 }}>
        <div className="flex items-start gap-4">
          {/* Project icon block */}
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'var(--navy-50)', color: 'var(--navy-900)' }}
            aria-hidden="true"
          >
            <Building2 className="h-7 w-7" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2.5">
              <h1
                className="truncate text-[26px] font-bold"
                style={{ color: 'var(--text)', lineHeight: 1.15 }}
              >
                <NameDisplay name={data.name} />
              </h1>
              <StatusBadge color={data.statusColor}>{data.statusLabel}</StatusBadge>
              {data.isArchived && (
                <span className="badge badge-neutral">
                  <span className="badge-dot" aria-hidden="true" />
                  <span>{t('archived')}</span>
                </span>
              )}
              {/* IAM slice 5b — Excel export gates on `export.run` (manager +;
               *  agent/viewer never → no dead export button). The disabled
               *  "PDF" placeholder ("בקרוב") was a coming-soon dead control;
               *  ship-or-hide → removed until the PDF export BE slice lands. */}
              {canExport && (
                <div className="ms-auto flex items-center gap-1.5">
                  {/* §V11 A.S15 — Excel export wired to B.S10 contract
                   *  (GET /api/v1/projects/:id/export?format=xlsx). */}
                  <ExportXlsxButton projectId={data.id} fallbackName={data.name} />
                </div>
              )}
            </div>

            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              {data.typeLabel}
              {data.targetConsentPct !== null && (
                <> · {t('field.consentThreshold', { pct: data.targetConsentPct })}</>
              )}{' '}
              · {data.createdRelative}
            </div>

            {/* KPI grid — wired to ProjectListItem stats. Contractor is still
             *  unwired (the org-tier wire doesn't expose contractor name yet
             *  — distinct slice). Signatures: signed / (signed+pending) ratio.
             *  Agents: distinct assigned users. */}
            <div
              className="mt-4 grid grid-cols-1 gap-4 pt-4 sm:grid-cols-3"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {t('kpi.contractor')}
                </div>
                <div
                  className="tabular mt-0.5 text-sm font-medium"
                  style={{ color: 'var(--text-muted)' }}
                >
                  —
                </div>
              </div>
              <div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {t('kpi.signatures')}
                </div>
                <div
                  className="tabular mt-0.5 text-sm font-medium"
                  style={{ color: 'var(--text)' }}
                >
                  {data.signaturesSignedCount !== undefined &&
                  data.signaturesPendingCount !== undefined
                    ? `${data.signaturesSignedCount}/${data.signaturesSignedCount + data.signaturesPendingCount}`
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {t('kpi.agents')}
                </div>
                <div
                  className="tabular mt-0.5 text-sm font-medium"
                  style={{ color: 'var(--text)' }}
                >
                  {data.agentsCount ?? '—'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs nav + content */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          role="tablist"
          aria-label={data.name}
          className="flex"
          style={{
            gap: 0,
            borderBottom: '1px solid var(--border)',
            padding: '0 8px',
            background: 'var(--bg-surface)',
          }}
        >
          {tabs.map((tabDef) => {
            const active = tab === tabDef.id;
            return (
              <button
                key={tabDef.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(tabDef.id)}
                style={{
                  padding: '12px 16px',
                  background: 'transparent',
                  border: 0,
                  fontSize: 14,
                  fontWeight: active ? 600 : 400,
                  color: active ? 'var(--navy-900)' : 'var(--text-muted)',
                  borderBottom: `2px solid ${active ? 'var(--navy-900)' : 'transparent'}`,
                  marginBottom: -1,
                  cursor: 'pointer',
                }}
              >
                {tabDef.label}
              </button>
            );
          })}
        </div>

        <div className="p-4">
          {tab === 'tenants' && (
            <TabEmptyCta
              icon={<Building2 className="h-10 w-10" style={{ color: 'var(--text-soft)' }} />}
              title={t('tenantsTab.title')}
              hint={t('tenantsTab.hint')}
              ctas={[
                {
                  label: t('tenantsTab.cta'),
                  href: `/projects/${data.id}/buildings`,
                  primary: true,
                },
              ]}
            />
          )}

          {tab === 'docs' && (
            <TabEmptyCta
              icon={<FileSignature className="h-10 w-10" style={{ color: 'var(--text-soft)' }} />}
              title={t('docsTab.title')}
              hint={t('docsTab.hint')}
              ctas={[
                { label: t('docsTab.docsCta'), href: '/documents', primary: true },
                { label: t('docsTab.signaturesCta'), href: '/signature-requests', primary: false },
              ]}
            />
          )}

          {tab === 'tasks' && (
            <TabEmptyCta
              icon={<ListChecks className="h-10 w-10" style={{ color: 'var(--text-soft)' }} />}
              title={t('tasksTab.title')}
              hint={t('tasksTab.hint')}
              ctas={[{ label: t('tasksTab.cta'), href: '/tasks', primary: true }]}
            />
          )}

          {tab === 'dashboard' && (
            <div className="flex flex-col gap-4">
              {/* Phase-6 "תמונת מצב" (S5a) — read-only signature-progress board:
               *  "X מתוך Y דירות הסכימו · Z% · יעד W%" + a threshold-colored bar.
               *  Self-fetches via useSignatureProgress (own query key); silent on
               *  error so it never blocks the rest of the detail page. */}
              {id && (
                <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
                  <SignatureProgressBoard projectId={id} />
                  {/* S5d — per-apartment drill-down under the 5a board.
                   *  Expandable, read-only; lazily fetches on first open. NO PII
                   *  (apartment designation + counts + status only). */}
                  <SignatureProgressApartments projectId={id} />
                  {/* S5c — in-context upload of a project-scoped signature
                   *  document (projectId set, apartmentId null). On success it
                   *  invalidates the documents query + the S5a board above so the
                   *  S5b picker below immediately sees the new doc. */}
                  <ProjectDocumentUpload projectId={id} />
                  {/* S5b — fan out a project document to ALL active owners.
                   *  BE-authoritative gate (signature_requests.send); the action
                   *  invalidates the board above + the signatures list on success. */}
                  <SignatureCampaignAction projectId={id} />
                </section>
              )}

              {/* P3c — "הקמה מגוש-חלקה": parcel-setup preview/confirm flow
               *  (block/parcel lookup → builder rows → PATCH payload →
               *  confirm → buildings skeleton). §7.1-2: the confirm stays
               *  disabled until the user makes an explicit apartments
               *  decision per building — never a silent default. */}
              {id && canCreateBuildings && <ParcelSetupSection projectId={id} />}

              {/* Owner-approved staged overlay (Gate-6) — signature progress
               *  bar with milestone tick marks + the legal target marker. Pure
               *  read over the existing signed/(signed+pending) stats; only
               *  rendered when those stats are wired (get() returns them). */}
              {data.signaturesSignedCount !== undefined &&
                data.signaturesPendingCount !== undefined && (
                  <section className="rounded-md border bg-card p-4">
                    <SignatureProgressBar
                      signedCount={data.signaturesSignedCount}
                      pendingCount={data.signaturesPendingCount}
                      targetPct={data.targetConsentPct}
                      milestones={data.signatureMilestones}
                    />
                  </section>
                )}

              {data.description && (
                <section className="rounded-md border bg-card p-4" aria-labelledby="proj-desc-h">
                  <h2 id="proj-desc-h" className="text-sm font-semibold">
                    {t('field.description')}
                  </h2>
                  <p
                    className="mt-1 whitespace-pre-wrap text-sm"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <NameDisplay name={data.description} />
                  </p>
                </section>
              )}

              {/* P3 create-form enrichment (migration 0062) — renewal details:
               *  developer (יזם), תמורה ratio, relocation (פינוי), parcel
               *  provenance (גוש-חלקה). Rendered only when at least one field
               *  is present so pre-feature / minimal projects stay clean. */}
              <RenewalDetailsSection data={data} />

              <section className="rounded-md border bg-card p-4" aria-labelledby="proj-buildings-h">
                <h2 id="proj-buildings-h" className="text-sm font-semibold">
                  {t('buildingsSection')}
                </h2>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('buildingsHint')}
                </p>
                <div className="mt-3">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/projects/${data.id}/buildings`}>{t('buildingsManage')}</Link>
                  </Button>
                </div>
              </section>

              <section className="rounded-md border bg-card p-4" aria-labelledby="proj-assign-h">
                <h2 id="proj-assign-h" className="text-sm font-semibold">
                  {t('assignmentsSection')}
                </h2>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('assignmentsHint')}
                </p>
                <div className="mt-3">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/projects/${data.id}/assignments`}>{t('assignmentsManage')}</Link>
                  </Button>
                </div>
              </section>

              <section className="rounded-md border bg-card p-4" aria-labelledby="proj-shares-h">
                <h2 id="proj-shares-h" className="text-sm font-semibold">
                  {t('sharesSection')}
                </h2>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('sharesHint')}
                </p>
                <div className="mt-3">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/projects/${data.id}/shares`}>{t('sharesManage')}</Link>
                  </Button>
                </div>
              </section>

              {!data.isArchived && canArchive && (
                <div className="flex items-center justify-end gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onArchive}
                    disabled={archive.isPending}
                  >
                    {archive.isPending ? t('archiving') : t('archive')}
                  </Button>
                </div>
              )}
              {actionError && (
                <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
                  {actionError}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Generic empty-state CTA panel for tabs that don't yet have an embedded
 * surface in this slice — keeps every tab visually consistent and lets the
 * user reach the canonical surface in one click.
 */
function TabEmptyCta({
  icon,
  title,
  hint,
  ctas,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  ctas: ReadonlyArray<{ label: string; href: string; primary: boolean }>;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      {icon}
      <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
        {title}
      </p>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {hint}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {ctas.map((cta) => (
          <Link
            key={cta.href}
            href={cta.href}
            className={cta.primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
          >
            {cta.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * P3 create-form enrichment (migration 0062) — read-only renewal details
 * panel on the project dashboard tab. Renders only the fields that are
 * present; if none are, renders nothing (pre-feature / minimal projects stay
 * clean). User-authored free text rides through `<NameDisplay>` (bidi
 * spoofing defence). Relocation enum + units-ratio formatting via i18n.
 */
function RenewalDetailsSection({ data }: { data: ProjectViewModel }) {
  // Dotted namespaces (skipped by the i18n-key-coverage scanner, like the
  // wizard's tw/tk aliases). The alias name MUST NOT be `t` — a `t` binding
  // would collide with the page-level `useTranslations('projects')` alias and
  // mis-resolve these keys to `projects.<key>` in the static scanner.
  const trd = useTranslations('projects.renewalDetail');
  const trel = useTranslations('projects.relocation');

  const hasDeveloper = data.developerName !== null || data.developerCompanyId !== null;
  const hasTmura =
    data.existingUnits !== null || data.plannedUnits !== null || data.extraAreaSqm !== null;
  const hasRelocation = data.relocationType !== null || data.relocationNotes !== null;
  const hasParcel = data.block !== null || data.parcel !== null || data.subparcel !== null;

  if (!hasDeveloper && !hasTmura && !hasRelocation && !hasParcel) return null;

  return (
    <section className="rounded-md border bg-card p-4" aria-labelledby="proj-renewal-h">
      <h2 id="proj-renewal-h" className="text-sm font-semibold">
        {trd('sectionTitle')}
      </h2>
      <dl className="mt-2 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
        {hasDeveloper && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>{trd('developer')}</dt>
            <dd>
              {data.developerName ? <NameDisplay name={data.developerName} /> : '—'}
              {data.developerCompanyId && (
                <span className="tabular ms-2" dir="ltr" style={{ color: 'var(--text-muted)' }}>
                  ({trd('developerCompanyId')} <NameDisplay name={data.developerCompanyId} />)
                </span>
              )}
            </dd>
          </>
        )}
        {hasTmura && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>{trd('tmura')}</dt>
            <dd>
              {(data.existingUnits !== null || data.plannedUnits !== null) && (
                <span className="tabular" dir="ltr">
                  {trd('unitsRatio', {
                    existing: data.existingUnits ?? '—',
                    planned: data.plannedUnits ?? '—',
                  })}
                </span>
              )}
              {data.extraAreaSqm !== null && (
                <span className="ms-2" style={{ color: 'var(--text-muted)' }}>
                  {trd('extraArea', { area: data.extraAreaSqm })}
                </span>
              )}
            </dd>
          </>
        )}
        {hasRelocation && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>{trd('relocation')}</dt>
            <dd>
              {data.relocationType ? trel(data.relocationType) : trel('unspecified')}
              {data.relocationNotes && (
                <span className="ms-2" style={{ color: 'var(--text-muted)' }}>
                  <NameDisplay name={data.relocationNotes} />
                </span>
              )}
            </dd>
          </>
        )}
        {hasParcel && (
          <>
            <dt style={{ color: 'var(--text-muted)' }}>{trd('parcel')}</dt>
            <dd className="tabular" dir="ltr">
              {trd('parcelValue', { block: data.block ?? '—', parcel: data.parcel ?? '—' })}
              {data.subparcel && trd('subparcelSuffix', { subparcel: data.subparcel })}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
