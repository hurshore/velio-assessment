import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { createInvitePolicy, experimentRoutes, type InviteConfig } from './experiments.js';
import type { AvailabilityEvent } from './outbox.js';
import { liveMetricsRoutes } from './live-metrics.js';
import { productRoutes, summaryRoutes } from './product-metrics.js';
import { bookingRoutes, recordInvalidBooking, type BookingDatabase } from './bookings.js';
import { eventRoutes } from './events.js';
import { activityRoutes } from './activities.js';
import { inviteCreationRoutes, inviteRoutes } from './invites.js';
import { DomainError } from './domain.js';
import { identityRoutes } from './identities.js';
import { reportFailure, type FailureReporter } from './diagnostics.js';
import { readinessTimeoutMs } from './readiness.js';

export interface Dependencies {
  postgres: BookingDatabase;
  redis: { ping: () => Promise<string> };
  invites: InviteConfig;
  liveProcessId?: string;
  accepting?: () => boolean;
  requestStarted?: () => () => void;
  committed?: (event: AvailabilityEvent) => void;
  liveHealth?: () => { processId: string; measurementFailures: number };
}

export function createApp(dependencies: Dependencies, webOrigin: string, logFailure: FailureReporter = reportFailure) {
  const invitePolicy = createInvitePolicy(dependencies.postgres, dependencies.invites);
  // Direct bookings and invite claims both publish committed availability and drain on shutdown.
  const live = { committed: dependencies.committed, processId: dependencies.liveProcessId, workStarted: dependencies.requestStarted };
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.locals.requestId = randomUUID();
    response.setHeader('X-Request-Id', response.locals.requestId);
    next();
  });
  const allowedMethods = ['GET', 'POST', 'OPTIONS'];
  const allowedHeaders = ['Content-Type', 'Idempotency-Key', 'X-Demo-Actor-Id'];
  app.use((request, response, next) => {
    response.vary('Origin');
    const originAllowed = request.headers.origin === webOrigin;
    if (originAllowed) {
      response.setHeader('Access-Control-Allow-Origin', webOrigin);
      response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      response.vary('Access-Control-Request-Method');
      response.vary('Access-Control-Request-Headers');
      const method = request.headers['access-control-request-method'];
      const headers = String(request.headers['access-control-request-headers'] ?? '')
        .split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
      if (!originAllowed || typeof method !== 'string' || !allowedMethods.includes(method) ||
          headers.some(header => !allowedHeaders.some(allowed => allowed.toLowerCase() === header))) {
        response.status(403).json({ error: { code: 'CORS_REQUEST_DENIED', message: 'Cross-origin request is not allowed.', retryable: false }, requestId: response.locals.requestId });
        return;
      }
      response.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
      response.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      response.status(204).end();
      return;
    }
    next();
  });
  app.use((_request, response, next) => {
    if (dependencies.accepting && !dependencies.accepting()) return next(new DomainError(503, 'SHUTTING_DOWN', 'API is shutting down. Retry on a healthy connection.'));
    const completed = dependencies.requestStarted?.();
    if (completed) {
      let done = false;
      const finish = () => { if (!done) { done = true; completed(); } };
      response.once('finish', finish); response.once('close', finish);
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_request, response) => {
    response.json({ data: { status: 'ok', service: 'velio-api' }, requestId: response.locals.requestId });
  });
  app.get('/api/ready', async (_request, response) => {
    const checks = await Promise.allSettled([
      bounded(dependencies.postgres.query('SELECT 1')),
      bounded(dependencies.redis.ping()),
    ]);
    checks.forEach((check, index) => {
      if (check.status === 'rejected') logFailure({ component: 'readiness', dependency: index === 0 ? 'postgres' : 'redis', requestId: response.locals.requestId }, check.reason);
    });
    if (checks.some(check => check.status === 'rejected') ||
        (checks[1]?.status === 'fulfilled' && checks[1].value !== 'PONG')) {
      response.status(503).json({
        error: { code: 'DEPENDENCIES_UNAVAILABLE', message: 'Service dependencies are unavailable. Please retry.', retryable: true },
        requestId: response.locals.requestId,
      });
      return;
    }
    response.json({ data: { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } }, requestId: response.locals.requestId });
  });
  app.use('/api/metrics', liveMetricsRoutes(dependencies.postgres, dependencies.liveHealth));
  app.use('/api/metrics', summaryRoutes(dependencies.postgres));
  app.use('/api/metrics', productRoutes(dependencies.postgres));
  app.use('/api/events', eventRoutes(dependencies.postgres));
  app.use('/api/activities', experimentRoutes(invitePolicy));
  app.use('/api/activities', bookingRoutes(dependencies.postgres, logFailure, live));
  app.use('/api/activities', inviteCreationRoutes(dependencies.postgres, invitePolicy));
  app.use('/api/activities', activityRoutes(dependencies.postgres, dependencies.invites, invitePolicy));
  app.use('/api/invites', inviteRoutes(dependencies.postgres, logFailure, live));
  app.use('/api/identities', identityRoutes(dependencies.postgres));
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.', retryable: false }, requestId: response.locals.requestId });
  });
  const handleError: ErrorRequestHandler = async (error, request, response, _next) => {
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, retryable: false }, requestId: response.locals.requestId });
      return;
    }
    logFailure({ component: 'http', requestId: response.locals.requestId }, error);
    const invalidJson = error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed';
    const oversized = error?.type === 'entity.too.large';
    const bookingPath = request.path.match(/^\/api\/activities\/([^/]+)\/bookings\/?$/);
    if ((invalidJson || oversized) && request.method === 'POST' && bookingPath) {
      let activityId: string | undefined;
      try { activityId = decodeURIComponent(bookingPath[1]!); } catch { /* Invalid path encoding has no entity context. */ }
      await recordInvalidBooking(dependencies.postgres, { requestId: response.locals.requestId, actorId: request.get('X-Demo-Actor-Id'), activityId,
        code: invalidJson ? 'INVALID_JSON' : 'PAYLOAD_TOO_LARGE' }, logFailure);
    }
    response.status(invalidJson ? 400 : oversized ? 413 : 500).json({
      error: {
        code: invalidJson ? 'INVALID_JSON' : oversized ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',
        message: invalidJson ? 'Request body must be valid JSON.' : oversized ? 'Request body is too large.' : 'Something went wrong. Please retry.',
        retryable: !invalidJson && !oversized,
      },
      requestId: response.locals.requestId,
    });
  };
  app.use(handleError);
  return app;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Readiness probe timed out')), readinessTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
