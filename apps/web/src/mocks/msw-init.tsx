'use client';

import { useEffect, useState } from 'react';

/**
 * MSW bootstrap (conditional on NEXT_PUBLIC_MSW=1).
 *
 * §RED-3 + §PERF-H1 closure:
 *  - `process.env['NEXT_PUBLIC_MSW']` is INLINED at build time. When
 *    the flag is unset (prod), the early-return `return <>{children}</>`
 *    becomes the only reachable branch and Terser dead-codes the
 *    useState + useEffect entirely. No client commit cycle, no
 *    `'use client'` runtime cost beyond the empty pass-through.
 *  - When the flag IS set (dev / Playwright with MSW), we mount the
 *    real worker and hold `children` until `worker.start()` resolves
 *    so no fetch fires before MSW can intercept.
 *  - Build-time guard in next.config.ts hard-fails the build if this
 *    env is set in production — the runtime gate is defense in depth.
 *
 * Used by:
 *  - Local offline dev (`NEXT_PUBLIC_MSW=1 pnpm --filter @emapp/web dev`)
 *
 * NOT loaded into the production bundle's hot path beyond the early
 * pass-through; the `import('./browser')` is dynamic and reachable
 * only inside the `flag === '1'` branch.
 */

const MSW_ENABLED = process.env['NEXT_PUBLIC_MSW'] === '1';

export function MswInit({ children }: { children: React.ReactNode }) {
  // Compile-time short-circuit — when MSW is disabled, Terser sees a
  // constant `false` here and dead-codes the rest of the component.
  if (!MSW_ENABLED) {
    return <>{children}</>;
  }
  return <MswInitLive>{children}</MswInitLive>;
}

function MswInitLive({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
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

  if (!ready) return null;
  return <>{children}</>;
}
