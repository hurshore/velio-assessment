import { Router } from 'express';
import { assignmentJson, type PolicyReason } from './experiments.js';
import { absoluteTime } from './activities.js';
import { DomainError, exact, marker, object, platform, rows, uuid, type Database } from './domain.js';

export function eventRoutes(db: Database) {
  const router = Router();
  router.post('/', async (request, response) => {
    const body = object(request.body);
    exact(body, ['id', 'schemaVersion', 'name', 'occurredAt', 'source', 'platform', 'actorId', 'journeyId', 'activityId', 'planId', 'synthetic', 'test', 'displayedInviteState']);
    const name = body.name;
    if (body.schemaVersion !== 1 || (name !== 'activity_viewed' && name !== 'experiment_exposed') || body.source !== 'client') {
      throw new DomainError(400, 'INVALID_REQUEST', 'Only schema 1 client activity_viewed and experiment_exposed events are accepted here.');
    }
    let displayedInviteState: { enabled: boolean; creationEnabled: boolean; reason: PolicyReason } | undefined;
    if (name === 'experiment_exposed') {
      const displayed = object(body.displayedInviteState);
      exact(displayed, ['enabled', 'creationEnabled', 'reason']);
      if (typeof displayed.enabled !== 'boolean' || typeof displayed.creationEnabled !== 'boolean' ||
        (displayed.reason !== 'allowed' && displayed.reason !== 'creation_disabled' && displayed.reason !== 'control' && displayed.reason !== 'host_or_booker_required' && displayed.reason !== 'assignment_unavailable') ||
        displayed.enabled !== (displayed.reason === 'allowed') || (displayed.enabled && !displayed.creationEnabled)) {
        throw new DomainError(400, 'INVALID_REQUEST', 'Exposure requires the displayed enabled state, creation switch and reason.');
      }
      displayedInviteState = { enabled: displayed.enabled, creationEnabled: displayed.creationEnabled, reason: displayed.reason };
    } else if (body.displayedInviteState !== undefined) {
      throw new DomainError(400, 'INVALID_REQUEST', 'Only exposure events may report invitation display state.');
    }
    const eventId = uuid(body.id, 'Event');
    const activityId = uuid(body.activityId, 'Activity');
    const journeyId = body.journeyId === undefined ? null : uuid(body.journeyId, 'Journey');
    const actorId = request.get('X-Demo-Actor-Id');
    if (body.actorId !== undefined && body.actorId !== actorId) throw new DomainError(400, 'INVALID_REQUEST', 'Event actor must match the selected demo identity.');
    if (!actorId && !journeyId) throw new DomainError(400, 'INVALID_REQUEST', 'A selected actor or persistent journey is required.');
    const [user] = actorId ? await rows(db, 'SELECT id, generation, synthetic, test FROM users WHERE id=$1', [uuid(actorId, 'Identity')]) : [];
    if (actorId && !user) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Selected demo identity was not found.');
    const [activity] = await rows(db, `SELECT p.id, host.synthetic, host.test, ${assignmentJson('e')} AS assignment FROM plans p JOIN activities a ON a.id=p.activity_id JOIN users host ON host.id=a.host_id LEFT JOIN experiment_assignments e ON e.activity_id=a.id WHERE p.activity_id=$1`, [activityId]);
    if (!activity) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
    if (body.planId !== undefined && uuid(body.planId, 'Plan') !== activity.id) throw new DomainError(400, 'INVALID_REQUEST', 'Plan does not belong to the activity.');
    const inserted = await rows(db, `INSERT INTO analytics_events
      (id, schema_version, name, occurred_at, source, platform, actor_id, journey_id, activity_id, plan_id, context, synthetic, test)
      VALUES ($1, 1, $11, $2, 'client', $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING RETURNING id`, [eventId, absoluteTime(body.occurredAt), platform(body.platform), actorId ?? null,
      journeyId, activityId, activity.id, { ...(user ? { generation: user.generation } : {}), assignment: activity.assignment, ...(displayedInviteState ? { displayedInviteState } : {}) },
      marker(body.synthetic) || user?.synthetic === true || activity.synthetic === true,
      marker(body.test) || user?.test === true || activity.test === true, name]);
    response.status(202).json({ data: { id: eventId, accepted: inserted.length === 1 }, requestId: response.locals.requestId });
  });
  return router;
}
