'use client';

import {
  ApartmentNumberingSchemeEnum,
  buildApartmentNumbers,
  type ApartmentNumberingScheme,
} from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useGenerateApartments } from '@/hooks/use-apartments';

const SCHEMES: ApartmentNumberingScheme[] = [...ApartmentNumberingSchemeEnum.options];

/**
 * Slice 2.1 — the technophobe "data-in wall" fix. A manager describes the
 * building's SHAPE ("כמה קומות × דירות") and confirms ONCE; the system creates
 * every apartment. Leads the apartments surface; the single-apartment form is
 * demoted to a secondary link below.
 *
 * The live preview ("ייווצרו N דירות · הראשונה … האחרונה …") is computed from
 * the SAME `buildApartmentNumbers` the BE loops — so what the manager sees is
 * exactly what gets created (one source of truth, no drift). One confirm →
 * the list refetches via the hook's cache invalidation.
 */
export function GenerateApartmentsForm({ buildingId }: { buildingId: string }) {
  const t = useTranslations('apartments.generate');
  const mutation = useGenerateApartments(buildingId);

  const [floors, setFloors] = useState(1);
  const [perFloor, setPerFloor] = useState(1);
  const [scheme, setScheme] = useState<ApartmentNumberingScheme>('sequential');
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const [failed, setFailed] = useState(false);

  // Clamp to the contract bounds (1–80 floors, 1–40 per floor, ≤500 total) so
  // the preview + submit never offer something the BE will 400.
  const clampedFloors = Math.min(Math.max(Math.trunc(floors) || 1, 1), 80);
  const clampedPerFloor = Math.min(Math.max(Math.trunc(perFloor) || 1, 1), 40);
  const overCap = clampedFloors * clampedPerFloor > 500;

  const preview = useMemo(
    () =>
      buildApartmentNumbers({
        floors: clampedFloors,
        apartmentsPerFloor: clampedPerFloor,
        scheme,
      }),
    [clampedFloors, clampedPerFloor, scheme],
  );

  const count = preview.length;
  const first = preview[0]?.number ?? '';
  const last = preview[count - 1]?.number ?? '';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (overCap) return;
    setResult(null);
    setFailed(false);
    try {
      const r = await mutation.mutateAsync({
        floors: clampedFloors,
        apartmentsPerFloor: clampedPerFloor,
        scheme,
      });
      setResult(r);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="rounded-md border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('title')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>

      {/* method="post" — FE-security DoD defense in depth (no GET fallback). */}
      <form method="post" action="" onSubmit={onSubmit} className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="gen-floors" className="text-sm font-medium">
              {t('floors')}
            </label>
            <input
              id="gen-floors"
              type="number"
              min={1}
              max={80}
              step={1}
              value={floors}
              onChange={(e) => setFloors(Number(e.target.value))}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="gen-per-floor" className="text-sm font-medium">
              {t('apartmentsPerFloor')}
            </label>
            <input
              id="gen-per-floor"
              type="number"
              min={1}
              max={40}
              step={1}
              value={perFloor}
              onChange={(e) => setPerFloor(Number(e.target.value))}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="gen-scheme" className="text-sm font-medium">
            {t('schemeLabel')}
          </label>
          <select
            id="gen-scheme"
            value={scheme}
            onChange={(e) => setScheme(e.target.value as ApartmentNumberingScheme)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            {SCHEMES.map((s) => (
              <option key={s} value={s}>
                {t(`scheme.${s}`)}
              </option>
            ))}
          </select>
        </div>

        <p className="text-sm text-muted-foreground" aria-live="polite">
          {count === 1 ? t('previewOne', { first }) : t('preview', { count, first, last })}
        </p>

        {result && (
          <p className="text-sm font-medium text-foreground" role="status" aria-live="polite">
            {result.created === 0
              ? t('noneCreated')
              : result.skipped > 0
                ? t('successWithSkipped', { created: result.created, skipped: result.skipped })
                : t('successCreated', { created: result.created })}
          </p>
        )}

        {failed && (
          <p className="text-sm text-destructive" role="alert" aria-live="assertive">
            {t('failed')}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending || overCap}>
            {mutation.isPending ? t('submitting') : t('submit', { count })}
          </Button>
        </div>
      </form>
    </div>
  );
}
