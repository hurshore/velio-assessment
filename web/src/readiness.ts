export const connectionErrorMessage = 'Could not connect to the API. Check your connection and retry.';
export const unexpectedResponseMessage = 'The API returned an unexpected response. Please retry.';
const dependencyErrorMessage = 'The API is running, but its dependencies are unavailable. Please retry.';

export type Readiness = { status: 'ready'; requestId: string } | { status: 'error'; message: string; requestId?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

export function parseReadiness(status: number, body: unknown): Readiness {
  if (!record(body) || !text(body.requestId)) throw new Error('Invalid response envelope');
  if (status === 200) {
    const data = body.data;
    if (!record(data) || data.status !== 'ok' || !record(data.dependencies) || data.dependencies.postgres !== 'ok' || data.dependencies.redis !== 'ok') {
      throw new Error('Invalid readiness payload');
    }
    return { status: 'ready', requestId: body.requestId };
  }
  if (status < 400 || !record(body.error) || !text(body.error.code) || !text(body.error.message) || typeof body.error.retryable !== 'boolean') {
    throw new Error('Invalid error envelope');
  }
  return { status: 'error', message: body.error.code === 'DEPENDENCIES_UNAVAILABLE' ? dependencyErrorMessage : connectionErrorMessage, requestId: body.requestId };
}
