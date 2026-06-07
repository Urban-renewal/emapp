'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  PROJECT_STATUS_COLORS,
  PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
} from '@/adapters/project';
import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  getContractorDocuments,
  getContractorDownloadUrl,
  getContractorProgress,
  getContractorProject,
} from '@/lib/api/contractor';

/**
 * D2-DEF-1 / D.46 — contractor read-view.
 *
 * Public page: the share-access token comes from the URL and is the sole
 * credential (Bearer, forwarded by the proxy to ContractorAuthGuard). The
 * view is structurally narrow — project + buildings + apartments
 * (structural), AGGREGATE signature progress, and manager-shared documents.
 * NO owner data is ever requested or rendered (there is no owner endpoint).
 *
 * Each section degrades independently: a 403 (permission off) renders the
 * section as "not shared" rather than failing the page.
 */
export default function ContractorSharePage() {
  const t = useTranslations('contractorView');
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  // Key on the token (defense-in-depth) so two distinct share-links can
  // never collide in the cache, even if a QueryProvider were ever shared.
  const project = useQuery({
    queryKey: ['contractor', 'project', token],
    queryFn: () => getContractorProject(token),
    enabled: Boolean(token),
    retry: false,
  });
  const progress = useQuery({
    queryKey: ['contractor', 'progress', token],
    queryFn: () => getContractorProgress(token),
    enabled: Boolean(token),
    retry: false,
  });
  const docs = useQuery({
    queryKey: ['contractor', 'documents', token],
    queryFn: () => getContractorDocuments(token),
    enabled: Boolean(token),
    retry: false,
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function onDownload(docId: string) {
    setDownloadError(null);
    try {
      const { url } = await getContractorDownloadUrl(token, docId);
      window.open(url, '_blank', 'noopener');
    } catch {
      setDownloadError(t('downloadFailed'));
    }
  }

  // A hard failure on the project fetch (invalid/expired/revoked token) is
  // the whole-page error — the link is dead.
  if (project.isError) {
    return (
      <div className="mx-auto max-w-2xl">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {t('invalidLink')}
        </p>
      </div>
    );
  }

  const pct =
    progress.data && progress.data.signaturesTotal > 0
      ? Math.round((progress.data.signaturesSigned / progress.data.signaturesTotal) * 100)
      : 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">
          {project.data ? <NameDisplay name={project.data.project.name} /> : t('loading')}
        </h1>
        {/* D.46 promised name/type/STATUS — the lifecycle stage is a contractor's
            primary question; the BE already returns it, the FE just dropped it. */}
        {project.data && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge color={PROJECT_STATUS_COLORS[project.data.project.status]}>
              {PROJECT_STATUS_LABELS[project.data.project.status]}
            </StatusBadge>
            <span className="text-sm text-muted-foreground">
              {PROJECT_TYPE_LABELS[project.data.project.type]}
            </span>
          </div>
        )}
      </div>

      {/* Aggregate progress — counts only, never who. */}
      {project.data?.permissions.signatures && progress.data && (
        <section className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">{t('progressSection')}</h2>
          <div
            className="relative h-2 w-full overflow-hidden rounded-full"
            style={{ background: 'var(--navy-100)' }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="absolute inset-y-0 start-0 rounded-full"
              style={{ width: `${pct}%`, background: 'var(--navy-700)' }}
            />
          </div>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('progressSummary', {
              signed: progress.data.signaturesSigned,
              total: progress.data.signaturesTotal,
              pct,
            })}
          </p>
        </section>
      )}

      {/* Buildings + apartments — structural only. */}
      {project.data && (
        <section className="card card-pad space-y-3">
          <h2 className="text-base font-semibold">{t('buildingsSection')}</h2>
          {project.data.buildings.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('noBuildings')}
            </p>
          ) : (
            project.data.buildings.map((b) => (
              <div key={b.id} className="rounded-md border p-3">
                <p className="text-sm font-medium">
                  <NameDisplay name={`${b.address}, ${b.city}`} />
                  {(b.block || b.parcel) && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' · '}
                      {t('cadastral', { block: b.block ?? '—', parcel: b.parcel ?? '—' })}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('apartmentCount', { count: b.apartments.length })}
                </p>
              </div>
            ))
          )}
        </section>
      )}

      {/* Manager-shared documents. */}
      {project.data?.permissions.documents && (
        <section className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">{t('documentsSection')}</h2>
          {!docs.data || docs.data.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('noDocuments')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {docs.data.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
                  <NameDisplay name={d.name} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onDownload(d.id)}
                  >
                    {t('download')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {downloadError && <p className="text-xs text-destructive">{downloadError}</p>}
        </section>
      )}
    </div>
  );
}
