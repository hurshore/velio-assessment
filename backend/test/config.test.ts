import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('normalizes the configured CORS origin and honors a nondefault API port', () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://runtime@localhost/db', REDIS_URL: 'redis://localhost', PORT: '3101', WEB_ORIGIN: 'http://LOCALHOST:5173/' });
  assert.equal(config.port, 3101);
  assert.equal(config.webOrigin, 'http://localhost:5173');
});

test('invitation rollout defaults retain a local holdout and reject ambiguous configuration', () => {
  const required = { DATABASE_URL: 'postgresql://runtime@localhost/db', REDIS_URL: 'redis://localhost' };
  assert.deepEqual(loadConfig(required).invites, { version: '1', treatmentPercent: 50, creationEnabled: true });
  assert.deepEqual(loadConfig({ ...required, INVITE_EXPERIMENT_VERSION: 'cohort-2', INVITE_TREATMENT_PERCENT: '90', INVITE_CREATION_ENABLED: 'false' }).invites,
    { version: 'cohort-2', treatmentPercent: 90, creationEnabled: false });
  for (const patch of [{ INVITE_EXPERIMENT_VERSION: '' }, { INVITE_TREATMENT_PERCENT: '-1' }, { INVITE_TREATMENT_PERCENT: '101' },
    { INVITE_TREATMENT_PERCENT: '0.5' }, { INVITE_TREATMENT_PERCENT: '' }, { INVITE_CREATION_ENABLED: 'yes' }]) {
    assert.throws(() => loadConfig({ ...required, ...patch }), /INVITE_/);
  }
});
