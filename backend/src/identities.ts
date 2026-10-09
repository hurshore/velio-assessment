import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { assignmentJson } from './experiments.js';
import { signupInviteId } from './invites.js';
import { contact, DomainError, exact, marker, object, platform, rows, text, uuid, type Database } from './domain.js';

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
    exact(body, ['displayName', 'journeyId', 'platform', 'synthetic', 'test', 'inviteCode', 'contact']);
    const id = randomUUID();
    const displayName = text(body.displayName, 'Display name', 100);
    const synthetic = marker(body.synthetic);
    const test = marker(body.test);
    const source = platform(body.platform);
    const journeyId = uuid(body.journeyId, 'Journey');
    const userContact = body.contact === undefined ? null : contact(body.contact, 'Contact');
    const inviteId = body.inviteCode === undefined ? null : await signupInviteId(db, body.inviteCode, userContact);
    // Acquisition and its event share one statement, so an event failure cannot orphan signup history.
    // Invited users inherit inviter markers so synthetic referral chains stay out of product metrics;
    // like other invite events, the signup event also inherits the activity host's markers.
    const [user] = await rows(db, `WITH invite AS (
      SELECT i.id, i.activity_id, i.plan_id, i.inviter_id, i.inviter_root_id, i.invitee_generation, i.rail, inviter.synthetic, inviter.test,
        host.synthetic AS host_synthetic, host.test AS host_test
      FROM invites i JOIN users inviter ON inviter.id=i.inviter_id JOIN activities a ON a.id=i.activity_id JOIN users host ON host.id=a.host_id
      WHERE i.id=$8
    ), new_user AS (
      INSERT INTO users (id, display_name, contact, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail, synthetic, test)
      SELECT $1, $2, $9, COALESCE(i.invitee_generation, 0), i.inviter_id, COALESCE(i.inviter_root_id, $1), i.id, i.rail,
        $3 OR COALESCE(i.synthetic, false), $4 OR COALESCE(i.test, false)
      FROM (SELECT 1) seed LEFT JOIN invite i ON true RETURNING *
    ), acquisition AS (
      INSERT INTO signup_attribution (user_id, generation, parent_id, root_id, invite_id, rail)
      SELECT id, generation, acquisition_parent_id, acquisition_root_id, acquisition_invite_id, acquisition_rail FROM new_user
    ), event AS (
      INSERT INTO analytics_events (id, schema_version, name, occurred_at, source, platform, actor_id, journey_id, activity_id, plan_id, invite_id, context, synthetic, test)
      SELECT $5, 1, 'identity_created', now(), 'server', $6, u.id, $7, i.activity_id, i.plan_id, u.acquisition_invite_id,
        jsonb_strip_nulls(jsonb_build_object('generation', u.generation, 'acquisitionRootId', u.acquisition_root_id,
          'acquisitionParentId', u.acquisition_parent_id, 'rail', u.acquisition_rail, 'acquisition', CASE WHEN u.acquisition_invite_id IS NULL THEN 'organic' ELSE 'invite' END))
        || CASE WHEN i.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('assignment',
          (SELECT ${assignmentJson('e')} FROM experiment_assignments e WHERE e.activity_id=i.activity_id)) END,
        u.synthetic OR COALESCE(i.host_synthetic, false), u.test OR COALESCE(i.host_test, false) FROM new_user u LEFT JOIN invite i ON true
    ) SELECT ${identityColumns} FROM new_user`, [id, displayName, synthetic, test, randomUUID(), source, journeyId, inviteId, userContact]).catch(error => {
      if (error?.code === '23505' && error.constraint === 'users_contact_key') {
        throw new DomainError(409, 'CONTACT_IN_USE', 'Another demo identity already uses this contact. Select that identity instead.');
      }
      throw error;
    });
    response.status(201).json({ data: user, requestId: response.locals.requestId });
  });
  return router;
}
