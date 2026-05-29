import { test, type Browser, type BrowserContext, type Page, expect } from '@playwright/test';

export const WEB = 'http://localhost:3001';
export const API = 'http://localhost:3000';

export interface DevUser {
  email: string;
  password: string;
  role: string;
  org: string;
}

export const USERS: Record<string, DevUser> = {
  manager: {
    email: 'manager@alpha.dev',
    password: 'DevPassword123!',
    role: 'manager',
    org: 'alpha',
  },
  agent: { email: 'agent@alpha.dev', password: 'DevPassword123!', role: 'agent', org: 'alpha' },
  viewer: { email: 'viewer@alpha.dev', password: 'DevPassword123!', role: 'viewer', org: 'alpha' },
  managerBeta: {
    email: 'manager@beta.dev',
    password: 'DevPassword123!',
    role: 'manager',
    org: 'beta',
  },
};

/**
 * Log in through the REAL login form (not API shortcut) so httpOnly
 * cookies land in the browser context exactly as a user would get them.
 * Returns once the dashboard root has loaded.
 */
export async function loginAs(page: Page, user: DevUser): Promise<void> {
  await page.goto(`${WEB}/he/login`, { waitUntil: 'networkidle' });
  // RHF must hydrate before fill, else the register() onChange never fires
  // and submit no-ops on an empty zod-validated form. Wait for interactivity.
  await page.waitForLoadState('networkidle');
  const submit = page.locator('button[type=submit]');
  await submit.waitFor({ state: 'visible' });

  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.fill('#email', '');
    await page.fill('#password', '');
    await page.fill('#email', user.email);
    await page.fill('#password', user.password);
    // verify RHF actually holds the values
    await expect(page.locator('#email')).toHaveValue(user.email);
    await submit.click();
    try {
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 12_000 });
      return;
    } catch {
      if (attempt === 2) {
        throw new Error(`loginAs(${user.email}) stayed on /login after 2 attempts`);
      }
      await page.waitForTimeout(1500); // let RHF finish hydration / rate window
    }
  }
}

export async function freshContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: WEB });
}

/** Capture console errors + page errors + responses for a page. */
export interface PageObservers {
  consoleErrors: string[];
  pageErrors: string[];
  responses: { url: string; status: number; ms: number }[];
  failed4xx5xx: { url: string; status: number }[];
}

export function observe(page: Page): PageObservers {
  const o: PageObservers = { consoleErrors: [], pageErrors: [], responses: [], failed4xx5xx: [] };
  const t0 = new Map<string, number>();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const txt = m.text();
      if (/Connection closed|WebSocket|ResizeObserver loop|HMR|Hot Module|favicon/i.test(txt))
        return;
      o.consoleErrors.push(txt);
    }
  });
  page.on('pageerror', (e) => o.pageErrors.push(e.message));
  page.on('request', (r) => t0.set(r.url(), Date.now()));
  page.on('response', (r) => {
    const url = r.url();
    const start = t0.get(url);
    const ms = start ? Date.now() - start : -1;
    if (url.includes('/api/v1') || url.includes('/_next/data')) {
      o.responses.push({ url, status: r.status(), ms });
    }
    if (r.status() >= 400 && (url.includes('/api/v1') || url.startsWith(WEB))) {
      // ignore expected auth-probe noise on _next assets
      if (!url.includes('/_next/static')) o.failed4xx5xx.push({ url, status: r.status() });
    }
  });
  return o;
}

export { test, expect };
