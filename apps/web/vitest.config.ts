import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

/**
 * v8.5 — vitest added to @emapp/web for the D.35 Pages Function
 * reverse-proxy spec. Phase 4a S2 adds the `@/` path alias so spec
 * files (and the application files they import) resolve identically
 * under tsc and vitest.
 *
 * Vite-side alias is preferred over a tsconfig-paths plugin to avoid
 * the ESM-only loader dance — `vite-tsconfig-paths` is ESM-only but
 * Vite loads this config via CJS (esbuild). A manual alias is two
 * lines and has zero ESM loader surface.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  rootConfig,
  defineConfig({
    resolve: {
      alias: {
        '@': path.resolve(here, 'src'),
      },
    },
    test: {
      include: ['src/**/*.spec.ts'],
      environment: 'node',
    },
  }),
);
