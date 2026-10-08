import { randomUUID } from 'node:crypto';
import { Router } from 'express';

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
const identityColumns = `id, display_name AS "displayName", generation,
  acquisition_parent_id AS "acquisitionParentId", acquisition_root_id AS "acquisitionRootId",
  synthetic, test`;
export function identityRoutes(db: Database) {
  const router = Router();
  router.get('/', async (_request, response) => {
    response.json({ data: await rows(db, `SELECT ${identityColumns} FROM users ORDER BY created_at, id`), requestId: response.locals.requestId });
  });
  router.get('/:id', async (request, response) => {
    const [user] = await rows(db, `SELECT ${identityColumns} FROM users WHERE id = $1`, [uuid(request.params.id, 'Identity')]);
    if (!user) throw new DomainError(404, 'NOT_FOUND', 'Demo identity was not found.');
    response.json({ data: user, requestId: response.locals.requestId });
  });
  router.post('/', async (request, response) => {
    const body = object(request.body);
    exact(body, ['displayName', 'journeyId', 'platform', 'synthetic', 'test']);
    const id = randomUUID();
    // Acquisition and its event share one statement, so an event failure cannot orphan signup history.
    const [user] = await rows(db, `WITH new_user AS (
      INSERT INTO users (id, display_name, generation, acquisition_root_id, synthetic, test)
      VALUES ($1, $2, 0, $1, $3, $4) RETURNING *
    ), acquisition AS (
      INSERT INTO signup_attribution (user_id, generation, root_id) SELECT id, 0, id FROM new_user
    ), event AS (
      INSERT INTO analytics_events (id, schema_version, name, occurred_at, source, platform, actor_id, journey_id, context, synthetic, test)
      SELECT $5, 1, 'identity_created', now(), 'server', $6, id, $7,
        jsonb_build_object('generation', 0, 'acquisitionRootId', id), synthetic, test FROM new_user
    ) SELECT ${identityColumns} FROM new_user`, [id, text(body.displayName, 'Display name', 100), marker(body.synthetic), marker(body.test), randomUUID(), platform(body.platform), uuid(body.journeyId, 'Journey')]);
    response.status(201).json({ data: user, requestId: response.locals.requestId });
  });
  return router;
}
