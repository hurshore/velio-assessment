import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../src/app.js';

test('process health stays available when dependencies fail', async () => {
  const app = createApp({
    postgres: { query: async () => { throw new Error('database unavailable'); } },
    redis: { ping: async () => { throw new Error('redis unavailable'); } },
  }, 'http://localhost:5173', () => {});
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, { status: 'ok', service: 'velio-api' });
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('x-request-id'), body.requestId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const failing of ['none', 'postgres', 'redis', 'both'] as const) {
  test(`readiness reflects ${failing} dependency failures without exposing details`, async () => {
    const app = createApp({
      postgres: { query: async () => {
        if (failing === 'postgres' || failing === 'both') throw new Error('private-db-password');
        return { rows: [{ '?column?': 1 }] };
      } },
      redis: { ping: async () => {
        if (failing === 'redis' || failing === 'both') throw new Error('private-redis-password');
        return 'PONG';
      } },
    }, 'http://localhost:5173', () => {});
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ready`);
      assert.equal(response.status, failing === 'none' ? 200 : 503);
      const body = await response.json();
      if (failing === 'none') {
        assert.deepEqual(body.data, { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } });
      } else {
        assert.deepEqual(body.error, { code: 'DEPENDENCIES_UNAVAILABLE', message: 'Service dependencies are unavailable. Please retry.', retryable: true });
        assert.ok(!JSON.stringify(body).includes('password'));
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
