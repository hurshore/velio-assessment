import { loadInviteConfig } from './experiments.js';
import { apiPort, httpOrigin } from '../../scripts/local-api.mjs';

const defaultWebOrigin = 'http://localhost:5173';

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  function required(name: string): string {
    const value = env[name];
    if (!value?.trim()) throw new Error(`${name} is required; fill the missing entry in .env (npm run setup reports missing keys). Preserve existing credentials.`);
    return value;
  }
  return {
    invites: loadInviteConfig(env),
    port: apiPort(env),
    host: env.HOST ?? '127.0.0.1',
    webOrigin: httpOrigin(env.WEB_ORIGIN ?? defaultWebOrigin, 'WEB_ORIGIN'),
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
  };
}
