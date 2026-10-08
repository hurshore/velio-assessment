const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
for (const path of ['/api/health', '/api/ready']) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || body.data?.status !== 'ok') throw new Error(`${path} failed: HTTP ${response.status}`);
  console.log(`${path}: ${JSON.stringify(body)}`);
}
