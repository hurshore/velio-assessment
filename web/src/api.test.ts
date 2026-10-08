import fixtures from '../../docs/contracts/readiness-fixtures.json';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from './api';
import { unexpectedResponseMessage } from './readiness';

afterEach(() => vi.unstubAllGlobals());
test('domain errors missing contract fields use unexpected-response guidance', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Database unavailable.' }, requestId: 'outage' }), { status: 503 })));
  await expect(api('/activities')).rejects.toThrow(unexpectedResponseMessage);
});

test('compliant domain errors retain message, code, retryability and request reference', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Choose a supported timezone.', retryable: false }, requestId: 'validation-ref' }), { status: 400 })));
  await expect(api('/activities')).rejects.toMatchObject({ message: 'Choose a supported timezone. (Request: validation-ref)', code: 'INVALID_REQUEST', retryable: false, requestId: 'validation-ref' });
});

test('non-JSON proxy failures use unexpected-response guidance', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 })));
  await expect(api('/activities')).rejects.toThrow(unexpectedResponseMessage);
});

const malformed = [
  { error: { code: '', message: 'Unavailable', retryable: true }, requestId: 'ref' },
  { error: { code: '   ', message: 'Unavailable', retryable: true }, requestId: 'ref' },
  { error: { code: 'BAD', message: '', retryable: true }, requestId: 'ref' },
  { error: { code: 'BAD', message: '  ', retryable: true }, requestId: 'ref' },
  { error: { code: 'BAD', message: 'Unavailable', retryable: true }, requestId: '  ' },
  { error: { code: 'BAD', message: 'Unavailable', retryable: true } },
];
for (const [index, body] of malformed.entries()) {
  test(`rejects malformed domain error fields ${index + 1}`, async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 503 })));
    await expect(api('/activities')).rejects.toThrow(unexpectedResponseMessage);
  });
}

for (const fixture of fixtures.filter(fixture => fixture.status >= 400)) {
  test(`domain helper shares readiness error validation: ${fixture.name}`, async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture.body), { status: fixture.status })));
    if (fixture.message === unexpectedResponseMessage) {
      await expect(api('/activities')).rejects.toThrow(unexpectedResponseMessage);
    } else {
      await expect(api('/activities')).rejects.toMatchObject({ requestId: 'fixture-ref' });
    }
  });
}
