import assert from 'node:assert/strict';
import test from 'node:test';
import { createShutdown } from '../src/shutdown.js';

test('shutdown contains cleanup failures, closes remaining resources, and runs once', async () => {
  const closed: string[] = [];
  const reported: string[] = [];
  const shutdown = createShutdown({
    http: async () => { closed.push('http'); throw new Error('listener close failed'); },
    redis: async () => { closed.push('redis'); },
    postgres: async () => { closed.push('postgres'); throw new Error('pool close failed'); },
  }, context => reported.push(context.component!));
  const outcomes = await Promise.all([shutdown(0), shutdown(0)]);
  assert.deepEqual(outcomes, [1, 1]);
  assert.deepEqual(closed, ['http', 'redis', 'postgres']);
  assert.deepEqual(reported, ['shutdown.http', 'shutdown.postgres']);
});
