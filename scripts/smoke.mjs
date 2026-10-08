import { existsSync } from 'node:fs';
import { localApiBase } from './local-api.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const base = localApiBase(process.env);
for (const path of ['/api/health', '/api/ready']) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
    let body;
    try { body = await response.json(); }
    catch { throw new Error(`HTTP ${response.status} did not return JSON`); }
    if (!response.ok || body?.data?.status !== 'ok') throw new Error(`HTTP ${response.status} did not report readiness`);
    console.log(`${path}: ${JSON.stringify(body)}`);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : 'request failed'}`, { cause: error });
  }
}
