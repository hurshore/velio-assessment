import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('normalizes the configured CORS origin and honors a nondefault API port', () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://runtime@localhost/db', REDIS_URL: 'redis://localhost', PORT: '3101', WEB_ORIGIN: 'http://LOCALHOST:5173/' });
  assert.equal(config.port, 3101);
  assert.equal(config.webOrigin, 'http://localhost:5173');
});
