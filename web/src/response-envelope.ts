export const unexpectedResponseMessage = 'The API returned an unexpected response. Please retry.';
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonemptyText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
export interface ResponseError { code: string; message: string; retryable: boolean }
type Envelope = { kind: 'success'; data: unknown; requestId: string } | { kind: 'error'; error: ResponseError; requestId: string };
export function parseEnvelope(status: number, body: unknown): Envelope {
  if (!isRecord(body) || !nonemptyText(body.requestId)) throw new Error(unexpectedResponseMessage);
  if (status >= 200 && status < 300 && 'data' in body) return { kind: 'success', data: body.data, requestId: body.requestId };
  if (status < 400 || !isRecord(body.error) || !nonemptyText(body.error.code) || !nonemptyText(body.error.message) || typeof body.error.retryable !== 'boolean') {
    throw new Error(unexpectedResponseMessage);
  }
  return { kind: 'error', error: { code: body.error.code, message: body.error.message, retryable: body.error.retryable }, requestId: body.requestId };
}
