import { Router } from 'express';
import { rows, type Database } from './domain.js';

export function liveMetricsRoutes(db: Database, health?: () => { processId: string; measurementFailures: number }) {
  const router = Router();
  router.get('/live', async (request, response) => {
    const instrumentation = health?.() ?? null;
    const includeTest = request.query.includeTest === 'true';
    const samples = await rows<{ timing: string; eventId: string; clientId: string | null; expected: number; ackAt: Date | null; delay: number | null; expired: boolean }>(db, `
      SELECT o.timing,o.event_id AS "eventId",o.expected,d.client_id AS "clientId",d.ack_at AS "ackAt",d.delay_ms AS delay,
        COALESCE(d.deadline <= clock_timestamp(),false) AS expired
      FROM live_observations o JOIN outbox_events e ON e.id=o.event_id
      JOIN bookings b ON b.id=e.booking_id JOIN users u ON u.id=b.user_id
      JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id
      LEFT JOIN live_deliveries d ON d.event_id=o.event_id AND d.process_id=o.process_id
      WHERE $1 OR NOT (u.synthetic OR u.test OR host.synthetic OR host.test)`, [includeTest]);
    // The transactional origin marker and durable gateway lifetimes survive failed writes and process restarts.
    const [gaps] = await rows<{ count: number }>(db, `WITH events AS (
      SELECT e.id,e.origin_process_id,COALESCE(source.observed_at,e.created_at) AS committed_at
      FROM outbox_events e JOIN bookings b ON b.id=e.booking_id JOIN users u ON u.id=b.user_id
      JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id
      LEFT JOIN live_observations source ON source.event_id=e.id AND source.process_id=e.origin_process_id AND source.timing='commit_observed'
      WHERE e.origin_process_id IS NOT NULL AND ($1 OR NOT (u.synthetic OR u.test OR host.synthetic OR host.test))
    ), required AS (
      SELECT id,origin_process_id AS process_id FROM events
      UNION
      SELECT e.id,p.process_id FROM events e JOIN live_processes p ON p.started_at <= e.committed_at
        AND (p.stopped_at IS NULL OR p.stopped_at >= e.committed_at)
    ) SELECT count(*)::integer AS count FROM required r WHERE NOT EXISTS (
      SELECT 1 FROM live_observations o WHERE o.event_id=r.id AND o.process_id=r.process_id
        AND (r.process_id <> (SELECT origin_process_id FROM events e WHERE e.id=r.id) OR o.timing='commit_observed')
    )`, [includeTest]);
    const instrumentationGaps = gaps!.count;
    const groups = ['commit_observed', 'pre_commit_proxy'].map(timing => {
      const selected = samples.filter(s => s.timing === timing);
      const deliveries = selected.filter(s => s.clientId !== null);
      const acknowledged = deliveries.filter(s => s.ackAt !== null);
      const misses = deliveries.filter(s => (s.ackAt !== null && s.delay! > 2000) || (s.expired && !s.ackAt)).length;
      const pending = deliveries.filter(s => !s.expired && !s.ackAt).length;
      const byBooking = new Map<string, number[]>();
      for (const s of acknowledged) byBooking.set(s.eventId, [...(byBooking.get(s.eventId) ?? []), s.delay!]);
      const byClient = new Map<string, number[]>();
      for (const s of acknowledged) byClient.set(s.clientId!, [...(byClient.get(s.clientId!) ?? []), s.delay!]);
      return { timing, observedBookings: new Set(selected.map(s => s.eventId)).size,
        bookingsWithSubscribers: new Set(deliveries.map(s => s.eventId)).size,
        expectedDeliveries: deliveries.length, acknowledged: acknowledged.length, deliveryMisses: misses, pending,
        coverage: deliveries.length ? acknowledged.length / deliveries.length : null,
        perBookingMaxima: [...byBooking].map(([eventId, values]) => ({ eventId, maximumMs: Math.max(...values) })),
        perBookingP95Ms: percentile([...byBooking.values()].map(values => Math.max(...values))),
        perClientP95Ms: percentile(acknowledged.map(s => s.delay!)),
        clients: [...byClient].map(([clientId, delays]) => ({ clientId, samples: delays.length, p95Ms: percentile(delays) })),
        everyClientTargetMet: instrumentationGaps ? false : deliveries.length && !pending ? misses === 0 && acknowledged.length === deliveries.length : null };
    });
    response.json({ data: { targetMs: 2000, includeTest, groups, instrumentation, instrumentationGaps, timingScope: 'One process clock; recovery is a pre-commit proxy. Multi-node exact correlation is unmeasured.' }, requestId: response.locals.requestId });
  });
  return router;
}
function percentile(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a,b) => a-b);
  return sorted[Math.ceil(sorted.length * .95)-1];
}
