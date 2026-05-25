'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useImportErrors } from '@/hooks/use-imports';

export default function ImportErrorsPage() {
  const t = useTranslations('imports');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const importId = params?.id;
  const { data, isLoading, isError, refetch } = useImportErrors(importId);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href={`/imports/${importId}`} className="underline">
          {tp('backToList')}
        </Link>
      </p>

      <h1 className="text-2xl font-bold">{t('errorsTitle')}</h1>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noErrors')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start">{t('errorRow')}</th>
                <th className="px-3 py-2 text-start">{t('errorField')}</th>
                <th className="px-3 py-2 text-start">{t('errorCode')}</th>
                <th className="px-3 py-2 text-start">{t('errorMessage')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className="border-b last:border-b-0">
                  <td className="px-3 py-2 font-mono text-xs">{e.rowNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.field ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-destructive">{e.code}</td>
                  <td className="px-3 py-2 text-xs">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
