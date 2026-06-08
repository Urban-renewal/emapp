/**
 * P4 #14 — the role→home BRANCH in the dashboard root Server Component.
 *
 * `page.tsx` is an ASYNC Server Component: `await getMe()` → if the
 * actor's role is `agent` it returns `<AgentHome/>`, otherwise (manager
 * / viewer / null / anything) `<ManagerHome/>`. The security-relevant
 * property: ONLY an agent gets the agent home, and an unresolved session
 * (`getMe()` → null) must NOT default to AgentHome (it falls back to the
 * manager home, which is itself BE-authoritative for every datum).
 *
 * Node-env note: vitest runs in `node` (no jsdom), and `renderToStaticMarkup`
 * cannot DRIVE an async Server Component (it doesn't await the returned
 * promise). So instead of rendering, we exercise the branch directly: mock
 * `getMe` + replace both home components with cheap MARKER elements, `await`
 * the component function, and assert WHICH marker `type` the returned React
 * element points at. This tests the real selection logic (the actual
 * `me?.role === 'agent'` predicate in page.tsx) — not a re-implementation.
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getMe is the only data dependency of the branch. Mutable per test.
let meValue: { role: string } | null = null;
const getMeMock = vi.fn(async () => meValue);
vi.mock('@/lib/auth', () => ({ getMe: () => getMeMock() }));

// Replace both homes with distinguishable marker components so the
// returned element's `type` identifies which branch was taken — no DOM,
// no data fetching, no async-SC render needed. The marker fns are defined
// INSIDE the factory (vi.mock is hoisted; a top-level const would not yet
// be initialised when the factory runs) and re-imported below to compare.
vi.mock('./_components/agent-home', () => ({
  AgentHome: () => createElement('div', { 'data-home': 'agent' }),
}));
vi.mock('./_components/manager-home', () => ({
  ManagerHome: () => createElement('div', { 'data-home': 'manager' }),
}));

import { AgentHome as AgentMarker } from './_components/agent-home';
import { ManagerHome as ManagerMarker } from './_components/manager-home';
import HomePage from './page';

/** Run the async Server Component and return the chosen home's component. */
async function chosenHome(role: string | null): Promise<unknown> {
  meValue = role === null ? null : { role };
  const element = (await HomePage()) as { type: unknown };
  return element.type;
}

beforeEach(() => {
  getMeMock.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('HomePage role→home branch (P4 #14)', () => {
  it('selects AgentHome for role "agent"', async () => {
    expect(await chosenHome('agent')).toBe(AgentMarker);
    expect(getMeMock).toHaveBeenCalledTimes(1);
  });

  it('selects ManagerHome for manager / viewer (non-agent roles)', async () => {
    for (const role of ['manager', 'viewer'] as const) {
      expect(await chosenHome(role), `role=${role}`).toBe(ManagerMarker);
    }
  });

  it('defaults to ManagerHome (NOT AgentHome) when getMe() is null', async () => {
    // Unresolved session: the branch MUST NOT fall to the agent home.
    // (Defaulting wrong here would either crash on an unauth render or
    //  silently widen — ManagerHome stays BE-authoritative.)
    expect(await chosenHome(null)).toBe(ManagerMarker);
  });

  it('does NOT open the agent branch for a near-miss role string', async () => {
    // The predicate is exact-string equality, not prefix/substring.
    for (const near of ['agents', 'Agent', 'provider_admin', 'contractor', 'tenant']) {
      expect(await chosenHome(near), `near=${near}`).toBe(ManagerMarker);
    }
  });
});
