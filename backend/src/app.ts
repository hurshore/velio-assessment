import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';

export interface Dependencies {
  postgres: { query: (sql: string) => Promise<unknown> };
  redis: { ping: () => Promise<string> };
}

export function createApp(dependencies: Dependencies, webOrigin = 'http://localhost:5173') {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.locals.requestId = randomUUID();
    response.setHeader('X-Request-Id', response.locals.requestId);
    next();
  });
  app.use((request, response, next) => {
    if (request.headers.origin === webOrigin) {
      response.setHeader('Access-Control-Allow-Origin', webOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
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
        timer = setTimeout(() => reject(new Error('Readiness probe timed out')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
