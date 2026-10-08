import assert from 'node:assert/strict';
import test from 'node:test';
import { reportFailure } from '../src/diagnostics.js';

test('diagnostics retain failure code and request context while redacting URL credentials', () => {
  const original = console.error;
  let logged: Record<string, any> | undefined;
  console.error = value => { logged = value; };
  try {
    const error = Object.assign(new Error('Connection failed at postgresql://user:secret@localhost/db'), { code: 'ECONNREFUSED' });
    reportFailure({ component: 'readiness', requestId: 'diagnostic-reference' }, error);
    assert.equal(logged?.requestId, 'diagnostic-reference');
    assert.equal(logged?.error.code, 'ECONNREFUSED');
    assert.ok(logged?.error.stack.includes('Connection failed'));
    assert.ok(!JSON.stringify(logged).includes('user:secret'));
  } finally { console.error = original; }
});
