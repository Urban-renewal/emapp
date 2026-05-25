'use client';

import { useEffect, useState } from 'react';

/**
 * MSW bootstrap (conditional on NEXT_PUBLIC_MSW=1).
 *
 * This is the ONLY app-code import of `./browser` — gated by the
 * `mocks-isolation.spec.ts` allow-list (Perf-5 closure). When the env
 * flag is off (production), `worker.start()` is never invoked AND
 * tree-shaking eliminates the dynamic `import('./browser')` chunk so
 * the ~80 KB MSW runtime does not ship.
 *
 * Used by:
 *  - Local offline dev (`NEXT_PUBLIC_MSW=1 pnpm --filter @emapp/web dev`)
 *  - Playwright E2E (webServer runs with NEXT_PUBLIC_MSW=1) — S11
 *
 * The component renders `children` immediately while the worker starts
 * in the background; MSW intercepts via the service-worker so pages
 * that fetch before the worker is ready will simply hit the real
 * upstream (acceptable for offline-dev — first paint may show
 * `/api/v1/me` 404 until the worker registers, then reloads).
 */
export function MswInit({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (process.env['NEXT_PUBLIC_MSW'] !== '1') {
      setReady(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { worker } = await import('./browser');
        await worker.start({ onUnhandledRequest: 'bypass' });
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // While the worker is starting we render nothing; this guarantees the
  // app never fires `/api/v1/*` before MSW is ready in offline mode
  // (which would otherwise fail the first render).
  if (!ready && process.env['NEXT_PUBLIC_MSW'] === '1') return null;
  return <>{children}</>;
}
