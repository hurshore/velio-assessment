import { rows, type Database } from './domain.js';
import { reportFailure, type FailureReporter } from './diagnostics.js';

export const availabilityChannel = 'velio:group-bookings:v1:availability';
export interface AvailabilityEvent {
  eventId: string; activityId: string; bookingId: string; version: number;
  capacity: number; confirmedCount: number; remainingSeats: number; createdAt: string;
}
export async function dispatchOutbox(db: Database, publish: (message: string) => Promise<unknown>, log: FailureReporter = reportFailure) {
  // Lease in one short statement; Redis never runs while a database lock is held.
  const events = await rows<{ id: string; payload: object; bookingId: string; createdAt: Date; attempts: number }>(db, `
    WITH pending AS (SELECT id FROM outbox_events WHERE dispatched_at IS NULL AND retry_at <= clock_timestamp()
      AND (lease_until IS NULL OR lease_until < clock_timestamp()) ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
    UPDATE outbox_events o SET lease_until=clock_timestamp()+interval '10 seconds', attempts=attempts+1
    FROM pending WHERE o.id=pending.id RETURNING o.id,o.payload,o.booking_id AS "bookingId",o.created_at AS "createdAt",o.attempts`);
  for (const event of events) {
    try {
      await publish(JSON.stringify({ ...event.payload, bookingId: event.bookingId, createdAt: event.createdAt.toISOString() }));
      await db.query('UPDATE outbox_events SET dispatched_at=clock_timestamp(),lease_until=NULL WHERE id=$1 AND dispatched_at IS NULL', [event.id]);
    } catch (error) {
      log({ component: 'outbox.publish', eventId: event.id }, error);
      await db.query(`UPDATE outbox_events SET lease_until=NULL,retry_at=clock_timestamp()+($2*interval '1 millisecond')
        WHERE id=$1 AND dispatched_at IS NULL`, [event.id, Math.min(30_000, 250 * 2 ** Math.min(event.attempts, 7))]);
    }
  }
  return events.length;
}
