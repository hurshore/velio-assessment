import { Router } from 'express';
import { rows, type Database } from './domain.js';
import type { BookingDatabase } from './bookings.js';
import { liveDeliveryReport, type LiveDeliveryReport, type LiveHealth } from './live-metrics.js';
import { maxIntegrityDetails, reliabilityMinResolvedIntents, reliabilityTarget, sampleStatus } from './metric-policy.js';
import { parseReportingWindow, unmarked, windowParameters, withReportSnapshot, type ReportingWindow } from './reporting.js';

export function summaryRoutes(db: BookingDatabase, health?: LiveHealth) {
  const router = Router();
  router.get('/summary', async (request, response) => {
    const window = parseReportingWindow(request.query as Record<string, unknown>);
    const data = await withReportSnapshot(db, async snapshot => ({
      includeTest: window.includeTest,
      window: { from: window.from.toISOString(), to: window.to.toISOString(),
        basis: 'Booking outcomes by analytics_events occurred_at; live delivery by outbox created_at; integrity is not windowed' },
      integrity: await integrity(snapshot),
      bookings: await bookingReliability(snapshot, window),
      live: liveSummary(await liveDeliveryReport(snapshot, window, health), window),
      scope: 'Local measurements with stated samples; not production SLO attainment.',
    }));
    response.json({ data, requestId: response.locals.requestId });
  });
  return router;
}

// Integrity is a global current-state check across every activity, independent of the
// reporting window and of synthetic/test markers: an oversold seed is still an oversell.
async function integrity(db: Database) {
  const [totals] = await rows<{ activities: number; oversold: number; mismatched: number; violating: number }>(db, `
    SELECT count(*)::integer AS activities, count(*) FILTER (WHERE oversold)::integer AS oversold,
      count(*) FILTER (WHERE counter_mismatch)::integer AS mismatched,
      count(*) FILTER (WHERE oversold OR counter_mismatch)::integer AS violating
    FROM booking_reconciliation`);
  const violations = await rows<{ activityId: string; capacity: number; confirmedCount: number; bookingCount: number;
    oversold: boolean; counterMismatch: boolean }>(db, `
    SELECT activity_id AS "activityId", capacity, confirmed_count AS "confirmedCount", booking_count AS "bookingCount",
      oversold, counter_mismatch AS "counterMismatch"
    FROM booking_reconciliation WHERE oversold OR counter_mismatch
    ORDER BY oversold DESC, activity_id LIMIT ${maxIntegrityDetails}`);
  const violating = totals?.violating ?? 0;
  return {
    scope: 'Global current state across all activities; ignores the reporting window and includeTest.',
    activitiesChecked: totals?.activities ?? 0,
    oversoldActivities: totals?.oversold ?? 0,
    counterMismatchActivities: totals?.mismatched ?? 0,
    violatingActivities: violating,
    target: 0,
    violation: violating > 0,
    violations,
    details: { limit: maxIntegrityDetails, truncated: violating > violations.length, omittedViolations: violating - violations.length },
  };
}

// Logical intents (PLANS.md §4.2). Requests correlate by actor, operation, activity and invite,
// so retries with a new idempotency key after an uncertain failure stay one intent. A request
// whose actor or activity never resolved has nothing stable to correlate on, so it stays its
// own intent instead of merging with unrelated failures. An intent then succeeds only on a
// committed outcome; otherwise an eligible technical failure is F, any other technical failure
// is U (eligibility unknown), and intents with only replays, sold-out or invalid outcomes are
// excluded from the rates but reported.
async function bookingReliability(db: Database, window: ReportingWindow) {
  const parameters = windowParameters(window);
  const outcomes = await rows<{ outcome: string; count: number }>(db, `
    SELECT context->>'outcome' AS outcome, count(*)::integer AS count FROM analytics_events
    WHERE name='booking_request_outcome' AND occurred_at >= $2 AND occurred_at < $3 AND ${unmarked('')}
    GROUP BY 1 ORDER BY 1`, parameters);
  const [attempts] = await rows<{ count: number }>(db, `
    SELECT count(*)::integer AS count FROM analytics_events
    WHERE name='booking_attempted' AND occurred_at >= $2 AND occurred_at < $3 AND ${unmarked('')}`, parameters);
  const [intents] = await rows<{ succeeded: number; eligibleFailures: number; unknownFailures: number; replayOnly: number;
    soldOut: number; invalid: number; distinctIntents: number; retried: number }>(db, `
    WITH requests AS (
      SELECT 'request:' || COALESCE(context->>'requestId', id::text) AS request_key, actor_id, activity_id, invite_id,
        context->>'operation' AS operation, context->>'activityId' AS context_activity,
        context->>'outcome' AS outcome, context->>'eligibility' AS eligibility
      FROM analytics_events
      WHERE name='booking_request_outcome' AND occurred_at >= $2 AND occurred_at < $3 AND ${unmarked('')}
    ), keyed AS (
      SELECT COALESCE(actor_id::text, request_key) AS actor_key, operation,
        COALESCE(activity_id::text, context_activity, request_key) AS activity_key,
        COALESCE(invite_id::text, '') AS invite_key, outcome, eligibility
      FROM requests
    ), intents AS (
      SELECT count(*) AS requests,
        bool_or(outcome='committed') AS committed,
        bool_or(outcome='technical_error' AND eligibility='eligible') AS eligible_failure,
        bool_or(outcome='technical_error' AND eligibility IS DISTINCT FROM 'eligible') AS unknown_failure,
        bool_or(outcome='replay') AS replayed,
        bool_or(outcome='sold_out') AS sold_out
      FROM keyed GROUP BY actor_key, operation, activity_key, invite_key
    ), classified AS (
      SELECT requests, CASE WHEN committed THEN 'succeeded' WHEN eligible_failure THEN 'eligible_failure'
        WHEN unknown_failure THEN 'unknown_failure' WHEN replayed THEN 'replay_only'
        WHEN sold_out THEN 'sold_out' ELSE 'invalid' END AS class
      FROM intents
    )
    SELECT count(*) FILTER (WHERE class='succeeded')::integer AS succeeded,
      count(*) FILTER (WHERE class='eligible_failure')::integer AS "eligibleFailures",
      count(*) FILTER (WHERE class='unknown_failure')::integer AS "unknownFailures",
      count(*) FILTER (WHERE class='replay_only')::integer AS "replayOnly",
      count(*) FILTER (WHERE class='sold_out')::integer AS "soldOut",
      count(*) FILTER (WHERE class='invalid')::integer AS invalid,
      count(*)::integer AS "distinctIntents",
      count(*) FILTER (WHERE requests > 1)::integer AS retried
    FROM classified`, parameters);
  const counted = new Map(outcomes.map(({ outcome, count }) => [outcome, count]));
  const totalRequests = outcomes.reduce((total, { count }) => total + count, 0);
  const succeeded = intents?.succeeded ?? 0;
  const eligibleFailures = intents?.eligibleFailures ?? 0;
  const unknownFailures = intents?.unknownFailures ?? 0;
  const resolved = succeeded + eligibleFailures;
  const status = sampleStatus(resolved, reliabilityMinResolvedIntents);
  return {
    rawOutcomes: {
      committed: counted.get('committed') ?? 0, replay: counted.get('replay') ?? 0,
      soldOut: counted.get('sold_out') ?? 0, invalid: counted.get('invalid') ?? 0,
      technicalError: counted.get('technical_error') ?? 0, total: totalRequests,
    },
    attempts: attempts?.count ?? 0,
    distinctIntents: intents?.distinctIntents ?? 0,
    retriedIntents: intents?.retried ?? 0,
    technicalErrorRate: totalRequests ? (counted.get('technical_error') ?? 0) / totalRequests : null,
    excludedIntents: { replayOnly: intents?.replayOnly ?? 0, soldOut: intents?.soldOut ?? 0, invalid: intents?.invalid ?? 0 },
    reliability: {
      succeeded, eligibleFailures, unknownFailures,
      eligibleRate: resolved ? succeeded / resolved : null,
      unknownInclusiveRate: resolved + unknownFailures ? succeeded / (resolved + unknownFailures) : null,
      resolvedIntents: resolved,
      target: reliabilityTarget,
      trigger: { resolvedIntents: reliabilityMinResolvedIntents },
      // Unknown failures alone still show there is data, just no resolved denominator.
      status: status === 'no_data' && unknownFailures ? 'insufficient_sample' : status,
    },
  };
}

// Headline figures from the same live report /api/metrics/live serves, so the two cannot
// disagree. Bookings observed without any subscriber never become expected or pending.
function liveSummary(report: LiveDeliveryReport, window: ReportingWindow) {
  const groups = report.groups.map(group => ({
    timing: group.timing, observedBookings: group.observedBookings, bookingsWithSubscribers: group.bookingsWithSubscribers,
    analysis: group.analysis,
    expectedDeliveries: group.expectedDeliveries, acknowledged: group.acknowledged, onTimeAcknowledged: group.onTimeAcknowledged,
    deliveryMisses: group.deliveryMisses, pending: group.pending, eventualAckCoverage: group.eventualAckCoverage,
    onTimeCoverage: group.onTimeCoverage, ackOnlyBookingSamples: group.ackOnlyBookingSamples,
    ackOnlyPerBookingP95Ms: group.ackOnlyPerBookingP95Ms, everyClientTargetMet: group.everyClientTargetMet,
  }));
  const observed = groups.reduce((total, group) => total + group.observedBookings, 0);
  const expected = groups.reduce((total, group) => total + group.expectedDeliveries, 0);
  const query = new URLSearchParams({ includeTest: String(window.includeTest), from: window.from.toISOString(), to: window.to.toISOString() });
  return {
    report: `/api/metrics/live?${query}`,
    targetMs: report.targetMs,
    status: !observed ? 'no_data' : !expected ? 'no_expected_deliveries' : 'reported',
    instrumentationGaps: report.instrumentationGaps,
    truncated: report.reporting.truncated,
    groups,
  };
}
