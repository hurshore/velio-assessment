import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { assignmentJson } from './experiments.js';
import { DomainError, exact, object, platform, rows, text, uuid, type Database } from './domain.js';
import type { AvailabilityEvent } from './outbox.js';
import type { FailureReporter } from './diagnostics.js';

export interface TransactionConnection extends Database { release(error?: boolean): void }
export interface BookingDatabase extends Database { connect?: () => Promise<TransactionConnection> }
interface Intent { actorId: string; activityId: string; key: string; platform: string; journeyId: string; requestId: string }
interface Actor { id: string; synthetic: boolean; test: boolean }
interface Availability { activityId: string; planId: string; capacity: number; confirmedCount: number; remainingSeats: number; version: number }
export interface Booking { id: string; activityId: string; planId: string; userId: string; priceMinor: number; currency: string; confirmedAt: Date }
interface BookingResult { booking: Booking; availability: Availability; replayed: boolean }
const bookingColumns = `id, activity_id AS "activityId", plan_id AS "planId", user_id AS "userId",
  price_minor AS "priceMinor", currency, confirmed_at AS "confirmedAt"`;
const availabilityColumns = `a.id AS "activityId", p.id AS "planId", a.capacity, a.confirmed_count AS "confirmedCount",
  a.capacity-a.confirmed_count AS "remainingSeats", a.version`;
export async function ownBooking(db: Database, activityId: string, actorId: string) {
  const [booking] = await rows<Booking>(db, `SELECT ${bookingColumns} FROM bookings WHERE activity_id=$1 AND user_id=$2`, [activityId, actorId]);
  return booking ?? null;
}
async function availability(db: Database, activityId: string): Promise<Availability> {
  const [value] = await rows<Availability>(db, `SELECT ${availabilityColumns} FROM activities a JOIN plans p ON p.activity_id=a.id WHERE a.id=$1`, [activityId]);
  if (!value) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
  return value;
}

// Success telemetry uses the transaction; attempts run before it and outcomes after rollback/commit through the pool.
async function event(db: Database, name: string, intent: Intent, actor: Actor, context: object, booking?: Booking) {
  await db.query(`INSERT INTO analytics_events
    (id,schema_version,name,occurred_at,source,platform,actor_id,journey_id,activity_id,plan_id,booking_id,context,synthetic,test)
    VALUES ($1,1,$2,clock_timestamp(),'server',$3,$4,$5,$6,$7,$8,$9::jsonb || jsonb_build_object('assignment',(SELECT ${assignmentJson('e')} FROM experiment_assignments e WHERE e.activity_id=$12)),
      $10 OR COALESCE((SELECT host.synthetic FROM activities a JOIN users host ON host.id=a.host_id WHERE a.id=$12),false),
      $11 OR COALESCE((SELECT host.test FROM activities a JOIN users host ON host.id=a.host_id WHERE a.id=$12),false))`,
  [randomUUID(), name, intent.platform, actor.id, intent.journeyId, booking?.activityId ?? null, booking?.planId ?? null,
    booking?.id ?? null, { ...context, requestId: intent.requestId, idempotencyKey: intent.key, operation: 'book_activity', activityId: intent.activityId }, actor.synthetic, actor.test, intent.activityId]);
}

export async function bookSeat(db: BookingDatabase, intent: Intent, actor: Actor, logFailure: FailureReporter, committed?: (event: AvailabilityEvent) => void, processId?: string) {
  let committedEvent: AvailabilityEvent | undefined;
  let telemetryFailed = false;
  async function observe(name: string, context: object) {
    try { await event(db, name, intent, actor, context); }
    catch (error) { telemetryFailed = true; logFailure({ component: 'booking.telemetry', requestId: intent.requestId }, error); }
  }
  await observe('booking_attempted', { eligibility: 'unknown' });
  let connection: TransactionConnection | undefined;
  let discard = false;
  let eligibility = 'unknown';
  let stage = 'connect';
  let result: BookingResult;
  try {
    if (!db.connect) throw new Error('Booking requires a connection pool');
    connection = await db.connect();
    await connection.query('BEGIN');
    await connection.query("SET LOCAL lock_timeout = '1500ms'");
    await connection.query("SET LOCAL statement_timeout = '4000ms'");
    stage = 'idempotency';
    const fingerprint = createHash('sha256').update(JSON.stringify({ activityId: intent.activityId })).digest('hex');
    // The unique key also serializes identical requests, including keys reused across activities.
    const inserted = await rows(connection, `INSERT INTO idempotency_keys (actor_id,operation,key,fingerprint)
      VALUES ($1,'book_activity',$2,$3) ON CONFLICT DO NOTHING RETURNING key`, [actor.id, intent.key, fingerprint]);
    const [saved] = await rows<{ fingerprint: string; result: BookingResult | null }>(connection, `SELECT fingerprint,result FROM idempotency_keys
      WHERE actor_id=$1 AND operation='book_activity' AND key=$2`, [actor.id, intent.key]);
    if (saved!.fingerprint !== fingerprint) throw new DomainError(409, 'IDEMPOTENCY_MISMATCH', 'This request key belongs to a different booking request.');
    if (!inserted.length && saved!.result) {
      result = { ...saved!.result, replayed: true };
    } else {
      stage = 'activity_lock';
      const [activity] = await rows<{ status: string; startsAt: Date; priceMinor: number; currency: string }>(connection,
        `SELECT status, starts_at AS "startsAt", price_minor AS "priceMinor", currency FROM activities WHERE id=$1 FOR UPDATE`, [intent.activityId]);
      if (!activity) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
      const snapshot = await availability(connection, intent.activityId);
      const existing = await ownBooking(connection, intent.activityId, actor.id);
      if (existing) result = { booking: existing, availability: snapshot, replayed: true };
      else {
        stage = 'reconciliation';
        const [reconciliation] = await rows<{ counter_mismatch: boolean; oversold: boolean }>(connection, 'SELECT counter_mismatch,oversold FROM booking_reconciliation WHERE activity_id=$1', [intent.activityId]);
        if (reconciliation!.counter_mismatch || reconciliation!.oversold) throw new Error('Booking membership and capacity counter disagree');
        stage = 'eligibility';
        if (activity.status !== 'scheduled') throw new DomainError(409, 'ACTIVITY_UNAVAILABLE', 'This activity is no longer bookable.');
        const [clock] = await rows<{ started: boolean }>(connection, 'SELECT $1::timestamptz <= clock_timestamp() AS started', [activity.startsAt]);
        if (clock!.started) throw new DomainError(409, 'ACTIVITY_STARTED', 'This activity has already started.');
        if (snapshot.remainingSeats === 0) { eligibility = 'sold_out'; throw new DomainError(409, 'SOLD_OUT', 'The last spot was just taken.'); }
        eligibility = 'eligible';
        stage = 'write';
        const [booking] = await rows<Booking>(connection, `INSERT INTO bookings (activity_id,plan_id,user_id,price_minor,currency)
          VALUES ($1,$2,$3,$4,$5) RETURNING ${bookingColumns}`, [intent.activityId, snapshot.planId, actor.id, activity.priceMinor, activity.currency]);
        await connection.query('UPDATE activities SET confirmed_count=confirmed_count+1,version=version+1 WHERE id=$1', [intent.activityId]);
        const updated = await availability(connection, intent.activityId);
        result = { booking: booking!, availability: updated, replayed: false };
        await event(connection, 'booking_succeeded', intent, actor, { eligibility, outcome: 'committed' }, booking);
        const outboxId = randomUUID();

        const [outbox] = await rows<{ createdAt: Date }>(connection, `INSERT INTO outbox_events (id,name,activity_id,booking_id,version,payload,origin_process_id)
          VALUES ($1,'availability_updated',$2,$3,$4,$5,$6) RETURNING created_at AS "createdAt"`, [outboxId, intent.activityId, booking!.id, updated.version, { eventId: outboxId, ...updated }, processId ?? null]);
        committedEvent = { eventId: outboxId, ...updated, bookingId: booking!.id, createdAt: outbox!.createdAt.toISOString() };
      }
      await connection.query(`UPDATE idempotency_keys SET result=$3 WHERE actor_id=$1 AND operation='book_activity' AND key=$2`, [actor.id, intent.key, result]);
    }
    stage = 'commit';
    await connection.query('COMMIT');
    if (committedEvent && committed) {
      try { committed(committedEvent); }
      catch (error) { telemetryFailed = true; logFailure({ component: 'live.commit_observation', requestId: intent.requestId }, error); }
    }
  } catch (error) {
    if (connection) {
      try { await connection.query('ROLLBACK'); }
      catch (rollbackError) { discard = true; logFailure({ component: 'booking.rollback', requestId: intent.requestId }, rollbackError); }
      connection.release(discard); connection = undefined;
    }
    const code = error instanceof DomainError ? error.code : 'TECHNICAL_ERROR';
    if (error instanceof DomainError && code !== 'SOLD_OUT') eligibility = 'ineligible';
    await observe(code === 'SOLD_OUT' ? 'booking_sold_out' : 'booking_failed', { outcome: error instanceof DomainError ? 'domain_rejected' : 'technical_error', code, stage, eligibility });
    await observe('booking_request_outcome', { outcome: error instanceof DomainError ? code === 'SOLD_OUT' ? 'sold_out' : 'invalid' : 'technical_error', code, stage, eligibility });
    throw error;
  } finally { connection?.release(discard); }
  await observe('booking_request_outcome', { outcome: result.replayed ? 'replay' : 'committed', eligibility: result.replayed ? 'replay' : eligibility });
  return { ...result, telemetry: telemetryFailed ? 'degraded' : 'ok' };
}

export function bookingRoutes(db: BookingDatabase, logFailure: FailureReporter, options: { committed?: (event: AvailabilityEvent) => void; processId?: string; workStarted?: () => () => void } = {}) {
  const router = Router();
  async function actor(value: string | undefined): Promise<Actor> {
    if (!value) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Select a demo identity before booking.');
    const [user] = await rows<Actor>(db, 'SELECT id,synthetic,test FROM users WHERE id=$1', [uuid(value, 'Identity').toLowerCase()]);
    if (!user) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Select an existing demo identity before booking.');
    return user;
  }
  router.get('/:id/booking', async (request, response) => {
    const user = await actor(request.get('X-Demo-Actor-Id'));
    const activityId = uuid(request.params.id, 'Activity').toLowerCase();
    // One MVCC snapshot prevents a new booking being paired with its pre-commit count.
    const [state] = await rows(db, `SELECT jsonb_build_object('booking',
      (SELECT row_to_json(b) FROM (SELECT ${bookingColumns} FROM bookings WHERE activity_id=a.id AND user_id=$2) b),
      'availability', jsonb_build_object('activityId',a.id,'planId',p.id,'capacity',a.capacity,
        'confirmedCount',a.confirmed_count,'remainingSeats',a.capacity-a.confirmed_count,'version',a.version)) AS state
      FROM activities a JOIN plans p ON p.activity_id=a.id WHERE a.id=$1`, [activityId, user.id]);
    if (!state) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
    response.json({ data: state.state, requestId: response.locals.requestId });
  });
  router.post('/:id/bookings', async (request, response) => {
    const completed = options.workStarted?.();
    try {
      let intent: Intent;
      let user: Actor | undefined;
      try {
        user = await actor(request.get('X-Demo-Actor-Id'));
        const body = object(request.body);
        exact(body, ['platform', 'journeyId']);
        intent = { actorId: user.id, activityId: uuid(request.params.id, 'Activity').toLowerCase(), key: text(request.get('Idempotency-Key'), 'Idempotency key', 128),
          platform: platform(body.platform), journeyId: uuid(body.journeyId, 'Journey'), requestId: response.locals.requestId };
      } catch (error) {
        await recordInvalidBooking(db, { requestId: response.locals.requestId, actorId: request.get('X-Demo-Actor-Id'), activityId: request.params.id,
          code: error instanceof DomainError ? error.code : 'TECHNICAL_ERROR', technical: !(error instanceof DomainError) }, logFailure);
        throw error;
      }
      const result = await bookSeat(db, intent, user, logFailure, options.committed, options.processId);
      response.status(result.replayed ? 200 : 201).json({ data: result, requestId: response.locals.requestId });
    } finally { completed?.(); }
  });
  return router;
}

function optionalUuid(value: string | undefined): string | null {
  try { return value ? uuid(value, 'Telemetry context').toLowerCase() : null; }
  catch { return null; }
}
export async function recordInvalidBooking(db: Database, context: { requestId: string; actorId?: string; activityId?: string; code: string; technical?: boolean }, logFailure: FailureReporter) {
  try {
    const activityId = optionalUuid(context.activityId);
    // Invalid/missing entities contribute no flags; only resolved database rows classify the request.
    await db.query(`INSERT INTO analytics_events (id,schema_version,name,occurred_at,source,platform,actor_id,journey_id,activity_id,context,test,synthetic)
      SELECT $1,1,'booking_request_outcome',clock_timestamp(),'server','web',actor.id,$2,a.id,
        $3::jsonb || jsonb_build_object('assignment',(SELECT ${assignmentJson('e')} FROM experiment_assignments e WHERE e.activity_id=a.id),'activityContext', CASE WHEN $5::uuid IS NULL THEN 'invalid_id' WHEN a.id IS NULL THEN 'not_found' ELSE 'resolved' END),
        COALESCE(actor.test,false) OR COALESCE(host.test,false), COALESCE(actor.synthetic,false) OR COALESCE(host.synthetic,false)
      FROM (SELECT 1) seed LEFT JOIN users actor ON actor.id=$4
      LEFT JOIN activities a ON a.id=$5 LEFT JOIN users host ON host.id=a.host_id`,
    [randomUUID(), context.requestId, { outcome: context.technical ? 'technical_error' : 'invalid', eligibility: context.technical ? 'unknown' : 'ineligible',
      stage: 'validation', requestId: context.requestId, code: context.code, platformKnown: false, operation: 'book_activity' }, optionalUuid(context.actorId), activityId]);
  } catch (error) { logFailure({ component: 'booking.telemetry', requestId: context.requestId }, error); }
}
