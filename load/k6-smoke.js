/* eslint-disable */
/**
 * EMAPP API load harness (k6) — turns "does it scale?" into a measured
 * gate instead of an opinion. Read-heavy org workload (the realistic
 * mix: many list/read, fewer writes) ramped over concurrent virtual
 * users, with SLO thresholds that FAIL the run if breached.
 *
 * Run (never against prod):
 *   k6 run -e BASE=https://staging.emapp... load/k6-smoke.js
 *   k6 run -e BASE=http://localhost:3000  load/k6-smoke.js   # local/Neon dev
 *
 * The point is to watch, while ramping VUs:
 *   - http_req_duration p95  (latency the customer feels)
 *   - http_req_failed        (error rate)
 *   - and SERVER-side: Postgres connection count + pg_stat_statements,
 *     Sentry performance. If p95 degrades as VUs rise while CPU is low,
 *     the bottleneck is DB connections → flip DATABASE_URL to the Neon
 *     transaction pooler (D.24) and lower DB_POOL_MAX per pod, re-run.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = (__ENV.BASE || 'http://localhost:3000') + '/api/v1';
const listTrend = new Trend('emapp_list_ms', true);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },
        { duration: '1m', target: 100 }, // sustained concurrent org users
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  // SLO gate — tune per product agreement; a breach fails the run (CI/release gate).
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% errors
    http_req_duration: ['p(95)<1500'], // p95 < 1.5s (raise if measuring vs cloud RTT)
    emapp_list_ms: ['p(95)<1200'],
  },
};

// One org/manager provisioned once; VUs reuse the session (read-heavy).
export function setup() {
  const email = `load_${Date.now()}@loadtest.local`;
  const res = http.post(
    `${BASE}/auth/signup`,
    JSON.stringify({ org_name: 'Load Org', name: 'Load Mgr', email, password: 'LoadPassword12' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'signup 2xx': (r) => r.status >= 200 && r.status < 300 });
  // k6 keeps the Set-Cookie in the jar of the VU that made the request;
  // for cross-VU reuse we extract and replay the access_token cookie.
  const cookie = (res.cookies['access_token'] || [{}])[0].value;
  // Seed a few projects so list pages are non-trivial.
  for (let i = 0; i < 25; i++) {
    http.post(`${BASE}/projects`, JSON.stringify({ name: `LP${i}`, type: 'tama38_1' }), {
      headers: { 'Content-Type': 'application/json', Cookie: `access_token=${cookie}` },
    });
  }
  return { cookie };
}

export default function (data) {
  const headers = { 'Content-Type': 'application/json', Cookie: `access_token=${data.cookie}` };

  // ~85% reads, ~15% writes — a realistic org mix.
  const t0 = Date.now();
  const list = http.get(`${BASE}/projects?limit=25`, { headers });
  listTrend.add(Date.now() - t0);
  check(list, { 'list 200': (r) => r.status === 200 });

  if (Math.random() < 0.15) {
    const c = http.post(
      `${BASE}/projects`,
      JSON.stringify({ name: `w_${__VU}_${__ITER}`, type: 'tama38_1' }),
      { headers },
    );
    check(c, { 'create 2xx': (r) => r.status >= 200 && r.status < 300 });
  }
  sleep(Math.random() * 0.5 + 0.2);
}
