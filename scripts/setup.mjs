import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

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
    'PORT=3000',
    'HOST=0.0.0.0',
    'WEB_ORIGIN=http://localhost:5173',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Created .env with distinct local runtime/migration credentials.');
} else {
  console.log('Preserved existing .env.');
}
