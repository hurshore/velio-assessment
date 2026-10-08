import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../src/app.js';

async function withApi(run: (base: string) => Promise<void>) {
  const app = createApp({
    postgres: { query: async () => ({ rows: [] }) }, redis: { ping: async () => 'PONG' },
  }, 'http://localhost:5173');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('allowed-origin preflight permits planned JSON and booking headers', async () => {
  await withApi(async base => {
    const response = await fetch(`${base}/api/ready`, { method: 'OPTIONS', headers: {
      Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,idempotency-key,x-demo-actor-id',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Idempotency-Key/i);
    assert.equal(await response.text(), '');
  });
});

for (const scenario of [
  { name: 'unknown route', path: '/missing', method: 'GET', body: undefined, status: 404, code: 'NOT_FOUND', retryable: false },
  { name: 'invalid JSON', path: '/api/ready', method: 'POST', body: '{', status: 400, code: 'INVALID_JSON', retryable: false },
  { name: 'oversized JSON', path: '/api/ready', method: 'POST', body: JSON.stringify({ text: 'x'.repeat(17000) }), status: 413, code: 'PAYLOAD_TOO_LARGE', retryable: false },
]) {
  test(`documented error contract for ${scenario.name}`, async () => {
    await withApi(async base => {
      const response = await fetch(`${base}${scenario.path}`, { method: scenario.method, body: scenario.body, headers: { 'Content-Type': 'application/json' } });
      assert.equal(response.status, scenario.status);
      const body = await response.json();
      assert.equal(body.error.code, scenario.code);
      assert.equal(body.error.retryable, scenario.retryable);
      assert.equal(typeof body.error.message, 'string');
      assert.match(body.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(response.headers.get('x-request-id'), body.requestId);
    });
  });
}

test('unexpected errors return a safe 500 and retain correlated server context', async () => {
  const original = Object.assign(new Error('unexpected database failure'), { code: 'EIO' });
  const reported: Array<{ context: Record<string, string>; error: unknown }> = [];
  const app = createApp({ postgres: { query: () => { throw original; } }, redis: { ping: async () => 'PONG' } },
    'http://localhost:5173', (context, error) => reported.push({ context, error }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ready`);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body.error, { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please retry.', retryable: true });
    assert.ok(!JSON.stringify(body).includes('database'));
    assert.equal(reported[0]?.context.requestId, body.requestId);
    assert.equal(reported[0]?.error, original);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const [origin, method, header] of [
  ['http://unapproved.local', 'POST', 'content-type'],
  ['http://localhost:5173', 'DELETE', 'content-type'],
  ['http://localhost:5173', 'POST', 'x-unapproved-header'],
]) {
  test(`preflight denies unapproved origin/method/headers: ${origin}/${method}/${header}`, async () => {
    await withApi(async base => {
      const response = await fetch(`${base}/api/ready`, { method: 'OPTIONS', headers: {
        Origin: origin!, 'Access-Control-Request-Method': method!, 'Access-Control-Request-Headers': header!,
      } });
      assert.equal(response.status, 403);
      if (origin !== 'http://localhost:5173') assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('access-control-allow-methods'), null);
    });
  });
}
