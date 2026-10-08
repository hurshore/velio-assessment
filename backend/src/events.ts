import { Router } from 'express';
import { absoluteTime } from './activities.js';
import { DomainError, exact, marker, object, platform, rows, uuid, type Database } from './domain.js';

export function eventRoutes(db: Database) {
  const router = Router();
  router.post('/', async (request, response) => {
    const body = object(request.body);
    exact(body, ['id', 'schemaVersion', 'name', 'occurredAt', 'source', 'platform', 'actorId', 'journeyId', 'activityId', 'planId', 'synthetic', 'test']);
    if (body.schemaVersion !== 1 || body.name !== 'activity_viewed' || body.source !== 'client') {
      throw new DomainError(400, 'INVALID_REQUEST', 'Only schema 1 client activity_viewed events are accepted here.');
    }
    const eventId = uuid(body.id, 'Event');
    const activityId = uuid(body.activityId, 'Activity');
    const journeyId = body.journeyId === undefined ? null : uuid(body.journeyId, 'Journey');
    const actorId = request.get('X-Demo-Actor-Id');
    if (body.actorId !== undefined && body.actorId !== actorId) throw new DomainError(400, 'INVALID_REQUEST', 'Event actor must match the selected demo identity.');
    if (!actorId && !journeyId) throw new DomainError(400, 'INVALID_REQUEST', 'A selected actor or persistent journey is required.');
    const [user] = actorId ? await rows(db, 'SELECT id, generation, synthetic, test FROM users WHERE id=$1', [uuid(actorId, 'Identity')]) : [];
    if (actorId && !user) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Selected demo identity was not found.');
    const [activity] = await rows(db, 'SELECT id FROM plans WHERE activity_id=$1', [activityId]);
    if (!activity) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
    if (body.planId !== undefined && uuid(body.planId, 'Plan') !== activity.id) throw new DomainError(400, 'INVALID_REQUEST', 'Plan does not belong to the activity.');
    const inserted = await rows(db, `INSERT INTO analytics_events
      (id, schema_version, name, occurred_at, source, platform, actor_id, journey_id, activity_id, plan_id, context, synthetic, test)
      VALUES ($1, 1, 'activity_viewed', $2, 'client', $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING RETURNING id`, [eventId, absoluteTime(body.occurredAt), platform(body.platform), actorId ?? null,
      journeyId, activityId, activity.id, user ? { generation: user.generation } : {},
      marker(body.synthetic) || user?.synthetic === true, marker(body.test) || user?.test === true]);
    response.status(202).json({ data: { id: eventId, accepted: inserted.length === 1 }, requestId: response.locals.requestId });
  });
  return router;
}
