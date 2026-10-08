import { randomUUID } from 'node:crypto';
import { attachLive } from './live.js';
import { dispatchOutbox, availabilityChannel } from './outbox.js';
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

const liveProcessId = randomUUID();
let live: ReturnType<typeof attachLive> | undefined;
const app = createApp({
  liveProcessId,
  committed: event => live?.committed(event),
  liveHealth: () => live!.health(),
  postgres,
  redis: { ping: () => redis.withCommandOptions({ abortSignal: AbortSignal.timeout(dependencyTimeoutMs) }).ping() },
}, config.webOrigin);
const server = app.listen(config.port, config.host, () => {
  console.log(`Velio API listening on ${config.host}:${config.port}`);
  console.log(`Live gateway process ${liveProcessId}`);
});
live = attachLive(server, postgres, config.webOrigin, { processId: liveProcessId });
const subscriber = redis.duplicate();
subscriber.on('error', error => reportFailure({ component: 'redis.subscriber' }, error));
void subscriber.connect().then(() => subscriber.subscribe(availabilityChannel, message => {
  void live!.published(message).catch(error => reportFailure({ component: 'live.publication' }, error));
})).catch(error => reportFailure({ component: 'redis.subscribe' }, error));
let dispatching = false;
const dispatcher = setInterval(() => {
  if (dispatching || !redis.isReady) return;
  dispatching = true;
  void dispatchOutbox(postgres, message => redis.withCommandOptions({ abortSignal: AbortSignal.timeout(dependencyTimeoutMs) }).publish(availabilityChannel, message))
    .catch(error => reportFailure({ component: 'outbox.dispatch' }, error)).finally(() => { dispatching = false; });
}, 100);
dispatcher.unref();
const shutdown = createShutdown({
  http: async () => {
    clearInterval(dispatcher);
    await live!.close();
    await new Promise<void>((resolve, reject) => server.close(error => {
      if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
      else resolve();
    }));
  },
  redis: async () => { if (subscriber.isOpen) subscriber.destroy(); if (redis.isOpen) redis.destroy(); },
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
