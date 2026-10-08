import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('smoke identifies the failing endpoint and HTTP status for non-JSON responses', async () => {
  const server = createServer((_request, response) => { response.writeHead(502, { 'Content-Type': 'text/html' }); response.end('<h1>Proxy error</h1>'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const child = spawn(process.execPath, [new URL('../smoke.mjs', import.meta.url).pathname], { env: { ...process.env, API_BASE_URL: `http://127.0.0.1:${port}` } });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, /\/api\/health: HTTP 502 did not return JSON/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
