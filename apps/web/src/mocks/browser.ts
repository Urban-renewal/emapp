/**
 * Browser-side MSW worker (Doc 05 §10 closure).
 *
 * Conditional bootstrap — start() is called only when
 * NEXT_PUBLIC_MSW=1 (set via Cloudflare Pages env or local .env.local
 * — see CLAUDE.md). In production this should never be set; mocks
 * must not ship.
 */
import { setupWorker } from 'msw/browser';

import { handlers } from './handlers';

export const worker = setupWorker(...handlers);
