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
// Accepts the grouped/lowercase forms people type from a shared message.
export function inviteCode(value: unknown): string {
  const code = typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(code)) throw new DomainError(404, 'INVALID_INVITE', 'This invitation code is not valid. Check the code and try again.');
  return code;
}
export async function rows<Row extends object = Record<string, unknown>>(db: Database, sql: string, parameters?: unknown[]): Promise<Row[]> {
  return (await db.query(sql, parameters) as { rows: Row[] }).rows;
}
const identityColumns = `id, display_name AS "displayName", generation,
  acquisition_parent_id AS "acquisitionParentId", acquisition_root_id AS "acquisitionRootId", acquisition_rail AS "acquisitionRail",
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
    exact(body, ['displayName', 'journeyId', 'platform', 'synthetic', 'test', 'inviteCode']);
    const id = randomUUID();
    const displayName = text(body.displayName, 'Display name', 100);
    const synthetic = marker(body.synthetic);
    const test = marker(body.test);
    const source = platform(body.platform);
    const journeyId = uuid(body.journeyId, 'Journey');
    // Only a live issued code stamps acquisition; its stored snapshot supplies every ancestry field.
    let inviteId: string | null = null;
    if (body.inviteCode !== undefined) {
      const [invite] = await rows<{ id: string; expired: boolean }>(db, 'SELECT id, expires_at <= clock_timestamp() AS expired FROM invites WHERE code=$1', [inviteCode(body.inviteCode)]);
      if (!invite) throw new DomainError(404, 'INVALID_INVITE', 'This invitation code is not valid. Check the code and try again.');
      if (invite.expired) throw new DomainError(410, 'INVITE_EXPIRED', 'This invitation has expired. Continue without it or ask for a new link.');
      inviteId = invite.id;
    }
    // Acquisition and its event share one statement, so an event failure cannot orphan signup history.
    // Invited users inherit inviter markers so synthetic referral chains stay out of product metrics.
    const [user] = await rows(db, `WITH invite AS (
      SELECT i.id, i.inviter_id, i.inviter_root_id, i.invitee_generation, i.rail, inviter.synthetic, inviter.test
      FROM invites i JOIN users inviter ON inviter.id=i.inviter_id WHERE i.id=$8
    ), new_user AS (
      INSERT INTO users (id, display_name, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail, synthetic, test)
      SELECT $1, $2, COALESCE(i.invitee_generation, 0), i.inviter_id, COALESCE(i.inviter_root_id, $1), i.id, i.rail,
        $3 OR COALESCE(i.synthetic, false), $4 OR COALESCE(i.test, false)
      FROM (SELECT 1) seed LEFT JOIN invite i ON true RETURNING *
    ), acquisition AS (
      INSERT INTO signup_attribution (user_id, generation, parent_id, root_id, invite_id, rail)
      SELECT id, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail FROM new_user
    ), event AS (
      INSERT INTO analytics_events (id, schema_version, name, occurred_at, source, platform, actor_id, journey_id, invite_id, context, synthetic, test)
      SELECT $5, 1, 'identity_created', now(), 'server', $6, id, $7, acquisition_invite_id,
        jsonb_strip_nulls(jsonb_build_object('generation', generation, 'acquisitionRootId', acquisition_root_id,
          'acquisitionParentId', acquisition_parent_id, 'rail', acquisition_rail, 'acquisition', CASE WHEN acquisition_invite_id IS NULL THEN 'organic' ELSE 'invite' END)),
        synthetic, test FROM new_user
    ) SELECT ${identityColumns} FROM new_user`, [id, displayName, synthetic, test, randomUUID(), source, journeyId, inviteId]);
    response.status(201).json({ data: user, requestId: response.locals.requestId });
  });
  return router;
}
