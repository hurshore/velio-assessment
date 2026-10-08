import { randomUUID } from 'node:crypto';
import { reportFailure, type FailureReporter } from './diagnostics.js';
import { readinessTimeoutMs } from './readiness.js';
import express, { type ErrorRequestHandler } from 'express';

export interface Dependencies {
  postgres: { query: (sql: string) => Promise<unknown> };
  redis: { ping: () => Promise<string> };
}

export function createApp(dependencies: Dependencies, webOrigin: string, logFailure: FailureReporter = reportFailure) {
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
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.', retryable: false }, requestId: response.locals.requestId });
  });
  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    logFailure({ component: 'http', requestId: response.locals.requestId }, error);
    const invalidJson = error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed';
    const oversized = error?.type === 'entity.too.large';
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
