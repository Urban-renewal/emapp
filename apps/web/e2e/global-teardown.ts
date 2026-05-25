/**
 * §E2E global-teardown — stops the mock backend started in
 * `global-setup.ts`. Safe to call even if startup failed (no-op).
 */
import { stopMockBackend } from './mock-backend';

export default async function globalTeardown(): Promise<void> {
  await stopMockBackend();
}
