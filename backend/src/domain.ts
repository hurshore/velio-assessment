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
// Demo contacts are unverified; normalization only makes typed variants of one contact match.
// Phone numbers are compared exactly after removing punctuation: no country code is inferred.
// Must match is_demo_contact in migrations/011_demo_contact_characters.sql, so a contact the API
// accepts can never fail the database check.
const contactExcluded = '@A-Z\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u206f\\u3000\\ufeff';
const contactPart = `[^${contactExcluded}]+`;
const contactPattern = new RegExp(`^(\\+?[0-9]{7,15}|${contactPart}@${contactPart}\\.${contactPart})$`, 'u');
export function contact(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const normalized = raw.includes('@') ? raw.toLowerCase() : raw.replace(/[\s().-]/g, '');
  if (normalized.length > 254 || !contactPattern.test(normalized)) {
    invalid(`${field} must be an email address or phone number without spaces, control or formatting characters.`);
  }
  return normalized;
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
