export interface Database { query(sql: string, parameters?: unknown[]): Promise<unknown> }
export class DomainError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function invalid(message: string): never { throw new DomainError(400, 'INVALID_REQUEST', message); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function exact(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid('Request contains unsupported fields.');
}
export function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`${field} must contain 1–${max} characters.`);
  return value.trim();
}
export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid(`${field} must be a UUID.`);
  return value;
}
export function marker(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') invalid('Synthetic and test markers must be booleans.');
  return value;
}
export function platform(value: unknown): string {
  if (value !== 'web' && value !== 'mobile') invalid('Platform must be web or mobile.');
  return value;
}
export async function rows<Row extends object = Record<string, unknown>>(db: Database, sql: string, parameters?: unknown[]): Promise<Row[]> {
  return (await db.query(sql, parameters) as { rows: Row[] }).rows;
}
