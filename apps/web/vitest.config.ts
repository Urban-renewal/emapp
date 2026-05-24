import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

/**
 * v8.5 — vitest added to @emapp/web for the D.35 Pages Function
 * reverse-proxy spec. Browser-side React components don't need
 * vitest yet (Phase 4 will add @testing-library/react when the
 * FE slices land); the route handler is a Node-side primitive.
 *
 * `globals: true` lets the spec use bare `describe / it / expect`
 * without per-file imports (mirrors api / db).
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      include: ['src/**/*.spec.ts'],
      environment: 'node',
    },
  }),
);
