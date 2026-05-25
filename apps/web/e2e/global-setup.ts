/**
 * §E2E global-setup — starts the Node-side mock backend BEFORE Playwright
 * boots the Next.js dev server. The port is published via process.env
 * so the webServer.env config can wire it into API_BACKEND_URL.
 *
 * Lifecycle:
 *   1. Playwright config imports + calls this (`globalSetup`).
 *   2. We start the mock backend on a fixed port (9999 by default).
 *   3. We export `API_BACKEND_URL` so the Next dev server (spawned
 *      AFTER this) sees it as part of its process env.
 *   4. Tests run; each test owns its handler registration + reset.
 *   5. `global-teardown.ts` stops the server.
 *
 * Note on env propagation:
 *   process.env mutations in globalSetup propagate to the webServer
 *   spawn — Playwright passes process.env (merged with webServer.env)
 *   to the child. This is the standard pattern for sharing
 *   global-setup state with the dev server.
 */
import { startMockBackend } from './mock-backend';

const MOCK_PORT = Number(process.env['E2E_MOCK_BACKEND_PORT'] ?? '9999');

export default async function globalSetup(): Promise<void> {
  const port = await startMockBackend({ port: MOCK_PORT });
  // Publish the upstream URL the proxy will use. webServer.env in
  // playwright.config can pin this, but we also write to process.env
  // so subprocess inheritance is bullet-proof.
  process.env['API_BACKEND_URL'] = `http://127.0.0.1:${port}`;
  // eslint-disable-next-line no-console -- single startup line, useful in CI
  console.log(`[e2e/global-setup] mock backend listening on 127.0.0.1:${port}`);
}
