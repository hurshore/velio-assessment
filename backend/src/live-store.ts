import { randomUUID } from 'node:crypto';
import { rows, type Database } from './domain.js';
import type { AvailabilityEvent } from './outbox.js';

export type Timing = 'commit_observed' | 'pre_commit_proxy';
export interface DeliveryClock { event: AvailabilityEvent; timing: Timing; started: number; sentVersion?: number }
export interface Observation {
  event: AvailabilityEvent; timing: Timing; started: number; observedAt: string;
  subscribers: { connectionId: string; clientId: string }[];
}
export async function saveObservation(db: Database, processId: string, observation: Observation) {
  const { event, timing, started, observedAt, subscribers } = observation;
  // Denominator and every captured expectation persist atomically, including disconnected clients.
  await db.query(`WITH observation AS (
    INSERT INTO live_observations (event_id,process_id,timing,observed_at,started_clock,expected)
    VALUES ($1,$2,$3,$7::timestamptz,$8,$4) ON CONFLICT DO NOTHING RETURNING event_id
  ) INSERT INTO live_deliveries (event_id,process_id,connection_id,client_id,deadline)
    SELECT $1,$2,connection_id,client_id,
      CASE WHEN $3='commit_observed' THEN $7::timestamptz+interval '2 seconds' ELSE $5::timestamptz+interval '2 seconds' END
    FROM jsonb_to_recordset($6::jsonb) AS subscriber(connection_id uuid,client_id uuid)
    WHERE EXISTS (SELECT 1 FROM observation)`, [event.eventId, processId, timing, subscribers.length, event.createdAt,
      JSON.stringify(subscribers.map(s => ({ connection_id: s.connectionId, client_id: s.clientId }))), observedAt, started]);
}
export async function recoverDelivery(db: Database, processId: string, connectionId: string, eventId: string): Promise<DeliveryClock | undefined> {
  const [delivery] = await rows<{ payload: AvailabilityEvent; bookingId: string; createdAt: Date; timing: Timing; started: number; sentVersion: number }>(db, `
    SELECT e.payload,e.booking_id AS "bookingId",e.created_at AS "createdAt",o.timing,o.started_clock AS started,d.sent_version AS "sentVersion"
    FROM live_deliveries d JOIN live_observations o USING (event_id,process_id) JOIN outbox_events e ON e.id=d.event_id
    WHERE d.event_id=$1 AND d.process_id=$2 AND d.connection_id=$3 AND d.ack_at IS NULL AND d.sent_version IS NOT NULL`, [eventId, processId, connectionId]);
  return delivery ? { ...delivery, event: { ...delivery.payload, bookingId: delivery.bookingId, createdAt: delivery.createdAt.toISOString() } } : undefined;
}
export async function saveAck(db: Database, context: { processId: string; connectionId: string; clientId: string; delivery: DeliveryClock; version: number; receivedClock: number; receivedAt: number }) {
  const { processId, connectionId, clientId, delivery, version, receivedClock, receivedAt } = context;
  const delay = delivery.timing === 'commit_observed' ? receivedClock - delivery.started : receivedAt - Date.parse(delivery.event.createdAt);
  await db.query(`WITH applied AS (
    UPDATE live_deliveries SET ack_at=clock_timestamp(),delay_ms=$4 WHERE event_id=$1 AND process_id=$2 AND connection_id=$3
      AND ack_at IS NULL RETURNING event_id
  ) INSERT INTO analytics_events (id,schema_version,name,occurred_at,source,platform,journey_id,activity_id,plan_id,booking_id,context,synthetic,test)
    SELECT $5,1,'availability_applied',clock_timestamp(),'client','web',$6,e.activity_id,b.plan_id,b.id,
      jsonb_build_object('eventId',e.id,'version',$7::integer,'timing',$8::text,'delayMs',$4::double precision),u.synthetic OR host.synthetic,u.test OR host.test
    FROM applied JOIN outbox_events e ON e.id=applied.event_id JOIN bookings b ON b.id=e.booking_id
    JOIN users u ON u.id=b.user_id JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id`,
    [delivery.event.eventId, processId, connectionId, Math.max(0, delay), randomUUID(), clientId, version, delivery.timing]);
}
