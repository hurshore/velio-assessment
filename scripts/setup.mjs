import { defaultApiPort } from './local-api.mjs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (!existsSync('.env')) {
  const migrationPassword = randomBytes(24).toString('hex');
  const runtimePassword = randomBytes(24).toString('hex');
  writeFileSync('.env', [
    'POSTGRES_DB=velio',
    'POSTGRES_USER=velio_migration',
    `POSTGRES_PASSWORD=${migrationPassword}`,
    'RUNTIME_DB_USER=velio_runtime',
    `RUNTIME_DB_PASSWORD=${runtimePassword}`,
    `DATABASE_URL=postgresql://velio_runtime:${runtimePassword}@127.0.0.1:5432/velio`,
    `MIGRATION_DATABASE_URL=postgresql://velio_migration:${migrationPassword}@127.0.0.1:5432/velio`,
    'REDIS_URL=redis://127.0.0.1:6379',
    `PORT=${defaultApiPort}`,
    'HOST=127.0.0.1',
    'WEB_ORIGIN=http://localhost:5173',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Created .env with distinct local runtime/migration credentials.');
} else {
  const env = parseEnv(readFileSync('.env', 'utf8'));
  const required = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'RUNTIME_DB_USER', 'RUNTIME_DB_PASSWORD', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'REDIS_URL'];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) {
    console.error(`Existing .env is incomplete: ${missing.join(', ')}. Fill only the missing entries using .env.example; preserve existing values and credentials. No file changes were made.`);
    process.exitCode = 1;
  } else {
    console.log('Preserved existing .env; required entries are present.');
  }
}
