import pg from 'pg';
import { createClient } from 'redis';
import { createApp } from './app.js';
import { createShutdown } from './shutdown.js';
import { reportFailure } from './diagnostics.js';
import { dependencyTimeoutMs } from './readiness.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const postgres = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: dependencyTimeoutMs,
  query_timeout: dependencyTimeoutMs,
  statement_timeout: dependencyTimeoutMs,
});
postgres.on('error', error => reportFailure({ component: 'postgres' }, error));
const redis = createClient({
  url: config.redisUrl,
  disableOfflineQueue: true,
  socket: { connectTimeout: dependencyTimeoutMs, reconnectStrategy: retries => Math.min(100 * (retries + 1), 2000) },
});
redis.on('error', error => reportFailure({ component: 'redis' }, error));
void redis.connect().catch(error => reportFailure({ component: 'redis.connect' }, error));

const app = createApp({
  postgres,
  redis: { ping: () => redis.withCommandOptions({ abortSignal: AbortSignal.timeout(dependencyTimeoutMs) }).ping() },
}, config.webOrigin);
const server = app.listen(config.port, config.host, () => {
  console.log(`Velio API listening on ${config.host}:${config.port}`);
});
const shutdown = createShutdown({
  http: () => new Promise<void>((resolve, reject) => server.close(error => {
    if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
    else resolve();
  })),
  redis: async () => { if (redis.isOpen) redis.destroy(); },
  postgres: () => postgres.end(),
});
function stop(exitCode = 0) {
  void shutdown(exitCode).then(code => { process.exitCode = code; }).catch(error => {
    reportFailure({ component: 'shutdown' }, error);
    process.exitCode = 1;
  });
}
server.on('error', error => {
  reportFailure({ component: 'http.listener' }, error);
  stop(1);
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
