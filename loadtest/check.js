// k6 load test for POST /permissions/check (run via loadtest/run.sh, or see docs/benchmarks.md).
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://gateway:3000';
const ADMIN = { headers: { Authorization: `Bearer ${__ENV.ADMIN_TOKEN}`, 'Content-Type': 'application/json' } };
const SERVICE = { headers: { Authorization: `Bearer ${__ENV.SERVICE_TOKEN}`, 'Content-Type': 'application/json' } };

const RATE = Number(__ENV.RATE || 500); // check requests per second
const DURATION = __ENV.DURATION || '30s';
const KEYS = Number(__ENV.KEYS || 200); // distinct API keys
const WRITE_RATE = Number(__ENV.WRITE_RATE || 0); // grants per second (each invalidates a cache entry)
const HOT_KEYS = Number(__ENV.HOT_KEYS || KEYS); // writes target the first N keys

const apiKey = (i) => `sk_load_${String(i).padStart(6, '0')}`;

const scenarios = {
  checks: {
    executor: 'constant-arrival-rate',
    exec: 'checkPermission',
    rate: RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.max(20, Math.ceil(RATE / 20)),
    maxVUs: Math.max(200, RATE),
  },
};
if (WRITE_RATE > 0) {
  scenarios.writes = {
    executor: 'constant-arrival-rate',
    exec: 'grantPermission',
    rate: WRITE_RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 5,
    maxVUs: 50,
  };
}

export const options = {
  scenarios,
  thresholds: {
    'http_req_failed{scenario:checks}': ['rate<0.01'],
    'http_req_duration{scenario:checks}': ['p(95)<50', 'p(99)<100'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// Every key gets orders:read; checks ask for orders:read (allowed) or orders:write (denied).
export function setup() {
  for (let i = 0; i < KEYS; i += 1) {
    const res = http.post(
      `${BASE_URL}/permissions/grant`,
      JSON.stringify({ apiKey: apiKey(i), module: 'orders', action: 'read' }),
      ADMIN,
    );
    if (res.status !== 200) throw new Error(`setup grant failed: ${res.status} ${res.body}`);
  }
}

export function checkPermission() {
  const i = Math.floor(Math.random() * KEYS);
  const action = Math.random() < 0.8 ? 'read' : 'write';
  const res = http.post(
    `${BASE_URL}/permissions/check`,
    JSON.stringify({ apiKey: apiKey(i), module: 'orders', action }),
    SERVICE,
  );
  check(res, {
    'status 200': (r) => r.status === 200,
    'correct answer': (r) => r.status === 200 && r.json('allowed') === (action === 'read'),
  });
}

export function grantPermission() {
  const i = Math.floor(Math.random() * HOT_KEYS);
  http.post(
    `${BASE_URL}/permissions/grant`,
    JSON.stringify({ apiKey: apiKey(i), module: 'billing', action: 'read' }),
    ADMIN,
  );
}
