import pg from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const postgres = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 1500,
  query_timeout: 1500,
  statement_timeout: 1500,
});
postgres.on('error', () => console.error('PostgreSQL connection interrupted'));
const redis = createClient({
  url: config.redisUrl,
  disableOfflineQueue: true,
  socket: { connectTimeout: 1500, reconnectStrategy: retries => Math.min(100 * (retries + 1), 2000) },
});
redis.on('error', () => console.error('Redis connection interrupted'));
void redis.connect().catch(() => console.error('Redis initial connection failed'));

const app = createApp({
  postgres,
  redis: { ping: () => redis.withCommandOptions({ abortSignal: AbortSignal.timeout(1500) }).ping() },
}, config.webOrigin);
const server = app.listen(config.port, config.host, () => {
  console.log(`Velio API listening on ${config.host}:${config.port}`);
});
server.on('error', () => {
  console.error('API listener failed');
  void shutdown(1);
});
let stopping = false;
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (redis.isOpen) redis.destroy();
  await postgres.end();
  clearTimeout(deadline);
  process.exitCode = exitCode;
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
