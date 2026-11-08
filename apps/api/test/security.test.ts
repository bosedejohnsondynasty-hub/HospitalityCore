import './env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { closeAll, getApp } from './helpers.js';

after(async () => {
  await closeAll();
});

test('security headers are present and no framework fingerprint is leaked', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(String(res.headers['x-frame-options']).length > 0, 'x-frame-options present');
  assert.equal(res.headers['x-powered-by'], undefined, 'no x-powered-by header');
});

test('CORS allows configured origins and rejects disallowed origins', async () => {
  const app = await getApp();
  const allowed = await app.inject({
    method: 'OPTIONS',
    url: '/api/v1/auth/login',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');

  const rejected = await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { origin: 'https://evil.example' },
  });
  assert.notEqual(
    rejected.headers['access-control-allow-origin'],
    'https://evil.example',
    'disallowed origin must not be reflected as allowed',
  );
});

test('rate limiting returns 429 after the configured maximum for a client IP', async () => {
  const app = await getApp();
  const rateLimitedIp = '203.0.113.99';
  let lastStatus = 0;
  // Default budget is 300 requests per minute; a 301st request must be limited.
  for (let i = 0; i < 301; i += 1) {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: rateLimitedIp,
    });
    lastStatus = res.statusCode;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429, 'client IP exceeding the request budget is rate limited');
});
