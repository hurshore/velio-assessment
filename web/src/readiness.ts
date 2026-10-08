import { isRecord, parseEnvelope, unexpectedResponseMessage } from './response-envelope';
export const connectionErrorMessage = 'Could not connect to the API. Check your connection and retry.';
export { unexpectedResponseMessage } from './response-envelope';
const dependencyErrorMessage = 'The API is running, but its dependencies are unavailable. Please retry.';

export type Readiness = { status: 'ready'; requestId: string } | { status: 'error'; message: string; requestId?: string };

export function parseReadiness(status: number, body: unknown): Readiness {
  const envelope = parseEnvelope(status, body);
  if (envelope.kind === 'success') {
    const data = envelope.data;
    if (status !== 200 || !isRecord(data) || data.status !== 'ok' || !isRecord(data.dependencies) || data.dependencies.postgres !== 'ok' || data.dependencies.redis !== 'ok') {
      throw new Error(unexpectedResponseMessage);
    }
    return { status: 'ready', requestId: envelope.requestId };
  }
  return { status: 'error', message: envelope.error.code === 'DEPENDENCIES_UNAVAILABLE' ? dependencyErrorMessage : connectionErrorMessage, requestId: envelope.requestId };
}
