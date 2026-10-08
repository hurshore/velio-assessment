import { Router } from 'express';
import { DomainError, exact, object, rows, text, uuid, type Database } from './domain.js';

function integer(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 2147483647) {
    throw new DomainError(400, 'INVALID_REQUEST', `${field} must be an integer between ${minimum} and 2147483647.`);
  }
  return value;
}
export function absoluteTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DomainError(400, 'INVALID_REQUEST', 'Start time must be an absolute ISO timestamp with an offset.');
  }
  // Date.parse normalizes impossible dates, so independently verify the calendar day.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new DomainError(400, 'INVALID_REQUEST', 'Timestamp contains an invalid calendar date.');
  }
  return new Date(value).toISOString();
}
const columns = `a.id, a.host_id AS "hostId", a.title, a.description, a.meeting_location AS "meetingLocation",
  a.starts_at AS "startsAt", a.timezone, a.status, a.capacity, a.confirmed_count AS "confirmedCount",
  a.capacity-a.confirmed_count AS "remainingSeats", a.price_minor AS "priceMinor", a.currency, a.version, p.id AS "planId"`;
export async function activityDetail(db: Database, id: string) {
  const [activity] = await rows(db, `SELECT ${columns},
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'displayName', u.display_name) ORDER BY b.confirmed_at, b.id)
      FROM bookings b JOIN users u ON u.id=b.user_id WHERE b.activity_id=a.id), '[]'::jsonb) AS participants
    FROM activities a JOIN plans p ON p.activity_id=a.id WHERE a.id=$1`, [id]);
  if (!activity) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
  return activity;
}
export function activityRoutes(db: Database) {
  const router = Router();
  router.get('/', async (_request, response) => {
    response.json({ data: await rows(db, `SELECT ${columns} FROM activities a JOIN plans p ON p.activity_id=a.id ORDER BY a.starts_at, a.id`), requestId: response.locals.requestId });
  });
  router.get('/:id', async (request, response) => {
    response.json({ data: await activityDetail(db, uuid(request.params.id, 'Activity')), requestId: response.locals.requestId });
  });
  router.post('/', async (request, response) => {
    const actor = request.get('X-Demo-Actor-Id');
    if (!actor) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Select a demo identity before hosting.');
    const [user] = await rows(db, 'SELECT id FROM users WHERE id=$1', [uuid(actor, 'Identity')]);
    if (!user) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Select an existing demo identity before hosting.');
    const body = object(request.body);
    exact(body, ['title', 'description', 'meetingLocation', 'startsAt', 'timezone', 'capacity', 'priceMinor', 'currency']);
    const startsAt = absoluteTime(body.startsAt);
    const inputTimezone = text(body.timezone, 'Timezone', 100);
    // Resolve using PostgreSQL's supported spelling, then check that clients can display it.
    const [zone] = await rows<{ timezone: string }>(db, `SELECT name AS timezone FROM pg_timezone_names
      WHERE lower(name)=lower($1) AND valid_display_timezone(name) ORDER BY name LIMIT 1`, [inputTimezone]);
    if (!zone) throw new DomainError(400, 'INVALID_REQUEST', 'Choose a supported IANA display timezone, such as Africa/Lagos or UTC.');
    const timezone = zone.timezone;
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
    catch { throw new DomainError(400, 'INVALID_REQUEST', 'This timezone is not supported for display. Choose another IANA timezone, such as Africa/Lagos or UTC.'); }
    const currency = text(body.currency, 'Currency', 3);
    if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError(400, 'INVALID_REQUEST', 'Currency must be an uppercase three-letter code.');
    const [activity] = await rows<{ id: string }>(db, `INSERT INTO activities
      (host_id,title,description,meeting_location,starts_at,timezone,capacity,price_minor,currency)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [actor, text(body.title, 'Title', 120),
      text(body.description, 'Description', 2000), text(body.meetingLocation, 'Meeting location', 300),
      startsAt, timezone, integer(body.capacity, 'Capacity', 1), integer(body.priceMinor, 'Price', 0), currency]);
    response.status(201).json({ data: await activityDetail(db, activity!.id), requestId: response.locals.requestId });
  });
  return router;
}
