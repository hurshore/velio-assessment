import assert from 'node:assert/strict';
import test from 'node:test';
import { apiPort, httpOrigin, localApiBase } from '../local-api.mjs';

test('local tooling follows PORT and an explicit device URL takes precedence', () => {
  assert.equal(localApiBase({ PORT: '3101' }), 'http://127.0.0.1:3101');
  assert.equal(localApiBase({ PORT: '3101', API_BASE_URL: 'http://192.168.1.10:3101/' }), 'http://192.168.1.10:3101');
});
for (const value of ['https://user:secret@host/', 'http://host/path', 'http://host/?x=1', 'file:///tmp/', 'not-a-url']) {
  test('rejects an invalid origin without echoing its value: ' + value.split(':')[0], () => {
    assert.throws(() => httpOrigin(value, 'WEB_ORIGIN'), /WEB_ORIGIN must be an HTTP\(S\) origin/);
  });
}
for (const port of ['abc', '65536', '3000.5', '']) {
  test(`rejects invalid PORT ${port}`, () => assert.throws(() => apiPort({ PORT: port }), /PORT must be an integer/));
}
