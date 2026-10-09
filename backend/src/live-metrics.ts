import { Router } from 'express';
import { rows, type Database } from './domain.js';
import type { BookingDatabase } from './bookings.js';
import { deliveryTargetMs, maxReportRows, maxReportDetails } from './live-policy.js';
import { parseReportingWindow, unmarked, windowParameters, withReportSnapshot, type ReportingWindow } from './reporting.js';

interface Sample { timing: string; eventId: string; clientId: string | null; expected: number; ackAt: Date | null; delay: number | null; expired: boolean }
interface Distribution { expected: number; acknowledged: number; pending: number; misses: number; delays: number[] }
function empty(): Distribution { return { expected: 0, acknowledged: 0, pending: 0, misses: 0, delays: [] }; }
function add(target: Distribution, sample: Sample) {
  target.expected++;
  if (sample.ackAt) { target.acknowledged++; target.delays.push(sample.delay!); }
  if ((sample.ackAt && sample.delay! > deliveryTargetMs) || (!sample.ackAt && sample.expired)) target.misses++;
  if (!sample.ackAt && !sample.expired) target.pending++;
}
function detail(target: Distribution) {
  return { expected: target.expected, acknowledged: target.acknowledged, pending: target.pending, deliveryMisses: target.misses,
    latencyStatus: !target.acknowledged ? 'no_data' : target.acknowledged < target.expected ? 'incomplete' : 'complete',
    ackOnlySamples: target.delays.length };
}
export type LiveHealth = () => { processId: string; measurementFailures: number };
export type LiveDeliveryReport = Awaited<ReturnType<typeof liveDeliveryReport>>;

export function liveMetricsRoutes(db: BookingDatabase, health?: LiveHealth) {
  const router = Router();
  router.get('/live', async (request, response) => {
    const window = parseReportingWindow(request.query as Record<string, unknown>);
    const data = await withReportSnapshot(db, snapshot => liveDeliveryReport(snapshot, window, health));
    response.json({ data, requestId: response.locals.requestId });
  });
  return router;
}

// The single implementation of the live delivery rules. Observations with no captured
// subscriber contribute to observedBookings only, never to expected or pending deliveries.
export async function liveDeliveryReport(db: Database, window: ReportingWindow, health?: LiveHealth) {
  const { includeTest, from, to } = window;
  const parameters = windowParameters(window);
  const samples = await rows<Sample>(db, `
    SELECT o.timing,o.event_id AS "eventId",o.expected,d.client_id AS "clientId",d.ack_at AS "ackAt",d.delay_ms AS delay,
      COALESCE(d.deadline <= clock_timestamp(),false) AS expired
    FROM outbox_events e JOIN live_observations o ON e.id=o.event_id
    JOIN bookings b ON b.id=e.booking_id JOIN users u ON u.id=b.user_id
    JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id
    LEFT JOIN live_deliveries d ON d.event_id=o.event_id AND d.process_id=o.process_id
    WHERE e.created_at >= $2 AND e.created_at < $3 AND ${unmarked('u', 'host')}
    ORDER BY e.created_at,e.id,o.process_id,d.connection_id LIMIT ${maxReportRows+1}`, parameters);
  const truncated = samples.length > maxReportRows;
  if (truncated) samples.pop();
  // Carry the origin requirement with each row; no correlated re-scan of the event CTE.
  const [gaps] = await rows<{ count: number }>(db, `WITH events AS (
    SELECT e.id,e.origin_process_id,COALESCE(source.observed_at,e.created_at) AS committed_at
    FROM outbox_events e JOIN bookings b ON b.id=e.booking_id JOIN users u ON u.id=b.user_id
    JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id
    LEFT JOIN live_observations source ON source.event_id=e.id AND source.process_id=e.origin_process_id AND source.timing='commit_observed'
    WHERE e.origin_process_id IS NOT NULL AND e.created_at >= $2 AND e.created_at < $3
      AND ${unmarked('u', 'host')}
  ), required AS (
    SELECT id,origin_process_id AS process_id,true AS is_origin FROM events
    UNION ALL
    SELECT e.id,p.process_id,false FROM events e JOIN live_processes p ON p.started_at <= e.committed_at
      AND (p.stopped_at IS NULL OR p.stopped_at > e.committed_at) AND p.process_id <> e.origin_process_id
  ) SELECT count(*)::integer AS count FROM required r WHERE NOT EXISTS (
    SELECT 1 FROM live_observations o WHERE o.event_id=r.id AND o.process_id=r.process_id
      AND (NOT r.is_origin OR o.timing='commit_observed')
  )`, parameters);
  const instrumentationGaps = gaps!.count;
  const groups = ['commit_observed', 'pre_commit_proxy'].map(timing => {
    const total = empty();
    const bookings = new Map<string, Distribution>();
    const clients = new Map<string, Distribution>();
    const observed = new Set<string>();
    for (const sample of samples) {
      if (sample.timing !== timing) continue;
      observed.add(sample.eventId);
      if (!sample.clientId) continue;
      const booking = bookings.get(sample.eventId) ?? empty(); bookings.set(sample.eventId, booking);
      const client = clients.get(sample.clientId) ?? empty(); clients.set(sample.clientId, client);
      add(total, sample); add(booking, sample); add(client, sample);
    }
    const maxima = [...bookings].map(([eventId, values]) => ({ eventId, ...detail(values),
      ackOnlyMaximumMs: values.delays.length ? Math.max(...values.delays) : null }));
    const clientDetails = [...clients].map(([clientId, values]) => ({ clientId, ...detail(values), ackOnlyP95Ms: percentile(values.delays) }));
    const onTime = total.acknowledged-total.delays.filter(delay => delay > deliveryTargetMs).length;
    return { timing, latencyBasis: 'ACK-only; missing ACKs have incomplete/no-data latency and remain in denominators',
      observedBookings: observed.size, bookingsWithSubscribers: bookings.size, expectedClients: clients.size,
      expectedDeliveries: total.expected, acknowledged: total.acknowledged, onTimeAcknowledged: onTime, deliveryMisses: total.misses, pending: total.pending,
      eventualAckCoverage: total.expected ? total.acknowledged/total.expected : null,
      onTimeCoverage: total.expected ? onTime/total.expected : null,
      ackOnlySamples: total.delays.length, ackOnlyBookingSamples: maxima.filter(value => value.ackOnlyMaximumMs !== null).length,
      ackOnlyPerBookingP95Ms: percentile(maxima.flatMap(value => value.ackOnlyMaximumMs === null ? [] : [value.ackOnlyMaximumMs])),
      ackOnlyPooledP95Ms: percentile(total.delays),
      worstClientAckOnlyP95Ms: maximum(clientDetails.flatMap(value => value.ackOnlyP95Ms === null ? [] : [value.ackOnlyP95Ms])),
      perBookingMaxima: maxima.slice(0,maxReportDetails), clients: clientDetails.slice(0,maxReportDetails),
      details: { limit: maxReportDetails, omittedBookings: Math.max(0,maxima.length-maxReportDetails), omittedClients: Math.max(0,clients.size-maxReportDetails) },
      everyClientTargetMet: instrumentationGaps || truncated || total.misses ? false : total.expected && !total.pending ? true : null };
  });
  return { targetMs: deliveryTargetMs, includeTest, groups, instrumentation: health?.() ?? null, instrumentationGaps,
    window: { from: from.toISOString(), to: to.toISOString(), basis: 'Persisted outbox created_at; ACK status at query time', maxDays: 7 },
    reporting: { rows: samples.length, rowLimit: maxReportRows, truncated, complete: !truncated, countsScope: truncated ? 'First bounded rows in window; no attainment claim' : 'Entire window' },
    timingScope: 'One process clock; recovery is a pre-commit proxy. Multi-node exact correlation is unmeasured.' };
}
function percentile(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a,b) => a-b);
  return sorted[Math.ceil(sorted.length * .95)-1]!;
}

function maximum(values: number[]) { return values.length ? Math.max(...values) : null; }
