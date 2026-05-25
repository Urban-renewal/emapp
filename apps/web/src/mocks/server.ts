/**
 * Node-side MSW server — for vitest specs that exercise integration
 * paths against deterministic SAMPLE_* data without a live API.
 *
 * Doc 05 §10 + Doc 11 §2 closure (§v9-P0-1).
 */
import { setupServer } from 'msw/node';

import { handlers } from './handlers';

export const server = setupServer(...handlers);
