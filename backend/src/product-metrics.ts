import { Router } from 'express';
import { rows, type Database } from './domain.js';
import { deliveryTargetMs } from './live-policy.js';
import { parseReportingWindow } from './reporting.js';

export function summaryRoutes(db: Database) {
  const router = Router();
  router.get('/summary', async (request, response) => {
    const { includeTest, from, to } = parseReportingWindow(request.query as Record<string, unknown>);
    const parameters = [includeTest, from.toISOString(), to.toISOString()];
    const [integrity] = await rows<{ activities: number; oversold: number; mismatched: number }>(db, `
      SELECT count(*)::integer AS activities,
        count(*) FILTER (WHERE oversold)::integer AS oversold,
        count(*) FILTER (WHERE counter_mismatch)::integer AS mismatched
      FROM booking_reconciliation`, []);
    const violations = await rows<{ activityId: string; capacity: number; confirmedCount: number; bookingCount: number;
      oversold: boolean; counterMismatch: boolean }>(db, `
      SELECT activity_id AS "activityId", capacity, confirmed_count AS "confirmedCount", booking_count AS "bookingCount",
        oversold, counter_mismatch AS "counterMismatch"
      FROM booking_reconciliation WHERE oversold OR counter_mismatch ORDER BY activity_id`, []);
    const outcomes = await rows<{ outcome: string; count: number }>(db, `
      SELECT context->>'outcome' AS outcome, count(*)::integer AS count FROM analytics_events
      WHERE name='booking_request_outcome' AND occurred_at >= $2 AND occurred_at < $3
        AND ($1 OR NOT (synthetic OR test))
      GROUP BY 1 ORDER BY 1`, parameters);
    const [attempts] = await rows<{ count: number }>(db, `
      SELECT count(*)::integer AS count FROM analytics_events
      WHERE name='booking_attempted' AND occurred_at >= $2 AND occurred_at < $3
        AND ($1 OR NOT (synthetic OR test))`, parameters);
    const [intents] = await rows<{ succeeded: number; eligibleFailures: number; unknownFailures: number; distinctIntents: number }>(db, `
      WITH requests AS (
        SELECT actor_id, context->>'operation' AS operation,
          COALESCE(activity_id::text, context->>'activityId') AS activity_key,
          COALESCE(invite_id::text, '') AS invite_key,
          context->>'outcome' AS outcome, context->>'eligibility' AS eligibility
        FROM analytics_events
        WHERE name='booking_request_outcome' AND occurred_at >= $2 AND occurred_at < $3
          AND actor_id IS NOT NULL AND ($1 OR NOT (synthetic OR test))
      ), intents AS (
        SELECT bool_or(outcome IN ('committed','replay')) AS succeeded,
          bool_or(outcome='technical_error' AND eligibility='eligible') AS eligible_failure,
          bool_or(outcome='technical_error' AND eligibility='unknown') AS unknown_failure
        FROM requests GROUP BY actor_id, operation, activity_key, invite_key
      )
      SELECT count(*) FILTER (WHERE succeeded)::integer AS "succeeded",
        count(*) FILTER (WHERE NOT succeeded AND eligible_failure)::integer AS "eligibleFailures",
        count(*) FILTER (WHERE NOT succeeded AND NOT eligible_failure AND unknown_failure)::integer AS "unknownFailures",
        count(*)::integer AS "distinctIntents"
      FROM intents`, parameters);
    const liveGroups = await rows<{ timing: string; expected: number; acknowledged: number; misses: number; pending: number;
      observedBookings: number; ackOnlyBookingSamples: number; ackOnlyPerBookingP95Ms: number | null }>(db, `
      WITH deliveries AS (
        SELECT e.id AS event_id, o.timing, d.ack_at, d.delay_ms,
          COALESCE(d.deadline <= clock_timestamp(), false) AS expired
        FROM outbox_events e
        JOIN live_observations o ON o.event_id=e.id
        LEFT JOIN live_deliveries d ON d.event_id=o.event_id AND d.process_id=o.process_id
        JOIN bookings b ON b.id=e.booking_id JOIN users bu ON bu.id=b.user_id
        JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id
        WHERE e.created_at >= $2 AND e.created_at < $3
          AND ($1 OR NOT (bu.synthetic OR bu.test OR host.synthetic OR host.test))
      ), per_booking AS (
        SELECT event_id, timing, max(delay_ms) FILTER (WHERE ack_at IS NOT NULL) AS max_delay,
          count(*) AS expected, count(ack_at) AS acknowledged,
          count(*) FILTER (WHERE (ack_at IS NOT NULL AND delay_ms > ${deliveryTargetMs}) OR (ack_at IS NULL AND expired)) AS misses,
          count(*) FILTER (WHERE ack_at IS NULL AND NOT expired) AS pending
        FROM deliveries GROUP BY event_id, timing
      )
      SELECT timing, sum(expected)::integer AS expected, sum(acknowledged)::integer AS acknowledged,
        sum(misses)::integer AS misses, sum(pending)::integer AS pending,
        count(*)::integer AS "observedBookings",
        count(*) FILTER (WHERE max_delay IS NOT NULL)::integer AS "ackOnlyBookingSamples",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY max_delay) AS "ackOnlyPerBookingP95Ms"
      FROM per_booking GROUP BY timing`, parameters);
    const liveExpected = liveGroups.reduce((total, group) => total + group.expected, 0);
    const succeeded = intents?.succeeded ?? 0;
    const eligibleFailures = intents?.eligibleFailures ?? 0;
    const unknownFailures = intents?.unknownFailures ?? 0;
    const resolved = succeeded + eligibleFailures;
    const counted = new Map(outcomes.map(({ outcome, count }) => [outcome, count]));
    response.json({ data: {
      includeTest,
      window: { from: from.toISOString(), to: to.toISOString(),
        basis: 'analytics_events occurred_at; integrity reads current state; live uses outbox created_at' },
      integrity: { activitiesChecked: integrity?.activities ?? 0, oversoldActivities: integrity?.oversold ?? 0,
        counterMismatchActivities: integrity?.mismatched ?? 0, target: 0,
        violation: (integrity?.oversold ?? 0) + (integrity?.mismatched ?? 0) > 0, violations },
      bookings: {
        rawOutcomes: {
          committed: counted.get('committed') ?? 0, replay: counted.get('replay') ?? 0,
          soldOut: counted.get('sold_out') ?? 0, invalid: counted.get('invalid') ?? 0,
          technicalError: counted.get('technical_error') ?? 0,
          total: outcomes.reduce((total, { count }) => total + count, 0),
        },
        attempts: attempts?.count ?? 0,
        distinctIntents: intents?.distinctIntents ?? 0,
        reliability: {
          succeeded, eligibleFailures, unknownFailures,
          eligibleRate: resolved ? succeeded / resolved : null,
          unknownInclusiveRate: resolved + unknownFailures ? succeeded / (resolved + unknownFailures) : null,
          resolvedIntents: resolved,
          target: 0.995,
          trigger: { resolvedIntents: 1000 },
          status: !resolved && !unknownFailures ? 'no_data' : resolved < 1000 ? 'insufficient_sample' : 'observed',
        },
      },
      live: {
        endpoint: `/api/metrics/live?includeTest=${includeTest}&from=${from.toISOString()}&to=${to.toISOString()}`,
        targetMs: deliveryTargetMs,
        status: liveExpected ? 'reported' : 'no_data',
        groups: liveGroups,
      },
      scope: 'Local measurements with stated samples; not production SLO attainment.',
    }, requestId: response.locals.requestId });
  });
  return router;
}

export function productRoutes(db: Database) {
  const router = Router();
  router.get('/product', async (request, response) => {
    const { includeTest, from, to } = parseReportingWindow(request.query as Record<string, unknown>);
    const parameters = [includeTest, from.toISOString(), to.toISOString()];
    const [bookers] = await rows<{ matureQualifying: number; matureInvited: number; immatureQualifying: number; immatureInvited: number;
      invitedVouch: number; invitedPublic: number; hostCreators: number }>(db, `
      WITH eligible AS (
        SELECT b.id, b.user_id, b.activity_id, b.confirmed_at FROM bookings b
        JOIN users u ON u.id=b.user_id JOIN activities a ON a.id=b.activity_id JOIN users host ON host.id=a.host_id
        WHERE b.confirmed_at >= $2 AND b.confirmed_at < $3
          AND ($1 OR NOT (u.synthetic OR u.test OR host.synthetic OR host.test))
      ), first_bookings AS (
        SELECT DISTINCT ON (user_id) user_id, activity_id, confirmed_at FROM eligible ORDER BY user_id, confirmed_at, id
      ), qualified AS (
        SELECT fb.*, fb.confirmed_at + interval '24 hours' <= $4 AS mature, inv.rail
        FROM first_bookings fb
        LEFT JOIN LATERAL (SELECT i.rail FROM invites i WHERE i.inviter_id=fb.user_id AND i.activity_id=fb.activity_id
          AND i.created_at >= fb.confirmed_at AND i.created_at <= fb.confirmed_at + interval '24 hours'
          ORDER BY i.created_at, i.id LIMIT 1) inv ON true
      ), host_creators AS (
        SELECT count(DISTINCT i.inviter_id)::integer AS creators FROM invites i
        JOIN users inviter ON inviter.id=i.inviter_id JOIN activities a ON a.id=i.activity_id JOIN users host ON host.id=a.host_id
        WHERE i.inviter_role='host' AND i.created_at >= $2 AND i.created_at < $3
          AND ($1 OR NOT (inviter.synthetic OR inviter.test OR host.synthetic OR host.test))
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id=i.inviter_id)
      )
      SELECT count(*) FILTER (WHERE mature)::integer AS "matureQualifying",
        count(*) FILTER (WHERE mature AND rail IS NOT NULL)::integer AS "matureInvited",
        count(*) FILTER (WHERE NOT mature)::integer AS "immatureQualifying",
        count(*) FILTER (WHERE NOT mature AND rail IS NOT NULL)::integer AS "immatureInvited",
        count(*) FILTER (WHERE mature AND rail='vouch')::integer AS "invitedVouch",
        count(*) FILTER (WHERE mature AND rail='public')::integer AS "invitedPublic",
        (SELECT creators FROM host_creators) AS "hostCreators"
      FROM qualified`, [...parameters, to.toISOString()]);
    const matureQualifying = bookers?.matureQualifying ?? 0;
    const matureInvited = bookers?.matureInvited ?? 0;
    const rate = matureQualifying ? matureInvited / matureQualifying : null;
    response.json({ data: {
      includeTest,
      window: { from: from.toISOString(), to: to.toISOString() },
      bookersInvite: {
        definition: "each user's first confirmed booking in the window; an invite for that activity within 24h counts as invited",
        mature: { qualifyingBookers: matureQualifying, invitedWithin24h: matureInvited, rate,
          wilson95: rate === null ? null : wilson95(matureInvited, matureQualifying),
          invitedByRail: { vouch: bookers?.invitedVouch ?? 0, public: bookers?.invitedPublic ?? 0 } },
        notYetMature: { qualifyingBookers: bookers?.immatureQualifying ?? 0, invitedWithin24h: bookers?.immatureInvited ?? 0 },
        hostCreatorsWithoutBooking: bookers?.hostCreators ?? 0,
        target: 0.3,
        trigger: { matureBookerJourneys: 200 },
        status: !matureQualifying ? 'no_data' : matureQualifying < 200 ? 'insufficient_sample' : 'observed',
      },
      openToClaim: await openToClaim(db, parameters, from, to),
      kFactor: await kFactor(db, parameters, from, to),
      holdout: await holdout(db, parameters),
      scope: 'Local measurements with stated samples; not production attainment.',
    }, requestId: response.locals.requestId });
  });
  return router;
}

// K by frozen acquisition rail: the cohort is every user existing at window start who
// already hosted or booked (including non-inviters). Direct acquisition requires the new
// user's frozen acquisition parent to be a cohort member; descendants of window-acquired
// users belong to later cohorts and appear only in the generation breakdown.
async function kFactor(db: Database, parameters: unknown[], from: Date, to: Date) {
  const [summary] = await rows<{ cohortSize: number; vouchAcquired: number; vouchActivated: number;
    publicAcquired: number; publicActivated: number }>(db, `
    WITH cohort AS (
      SELECT u.id FROM users u
      WHERE u.created_at < $2 AND ($1 OR NOT (u.synthetic OR u.test))
        AND (EXISTS (SELECT 1 FROM activities a WHERE a.host_id=u.id AND a.created_at < $2)
          OR EXISTS (SELECT 1 FROM bookings b WHERE b.user_id=u.id AND b.confirmed_at < $2))
    ), acquired AS (
      SELECT n.id, n.acquisition_rail AS rail,
        EXISTS (SELECT 1 FROM bookings b WHERE b.user_id=n.id AND b.confirmed_at >= n.created_at AND b.confirmed_at < $3) AS activated
      FROM users n JOIN cohort c ON c.id=n.acquisition_parent_id
      WHERE n.created_at >= $2 AND n.created_at < $3 AND n.acquisition_rail IS NOT NULL
        AND ($1 OR NOT (n.synthetic OR n.test))
    )
    SELECT (SELECT count(*)::integer FROM cohort) AS "cohortSize",
      count(*) FILTER (WHERE rail='vouch')::integer AS "vouchAcquired",
      count(*) FILTER (WHERE rail='vouch' AND activated)::integer AS "vouchActivated",
      count(*) FILTER (WHERE rail='public')::integer AS "publicAcquired",
      count(*) FILTER (WHERE rail='public' AND activated)::integer AS "publicActivated"
    FROM acquired`, parameters);
  const generations = await rows<{ generation: number; users: number }>(db, `
    SELECT generation, count(*)::integer AS users FROM users
    WHERE created_at >= $2 AND created_at < $3 AND ($1 OR NOT (synthetic OR test))
    GROUP BY generation ORDER BY generation`, parameters);
  const cohortSize = summary?.cohortSize ?? 0;
  const rail = (acquired: number, activated: number) => ({
    acquired, activated,
    k: cohortSize ? acquired / cohortSize : null,
    activatedK: cohortSize ? activated / cohortSize : null,
  });
  return {
    definition: 'distinct new users directly acquired by the fixed cohort within the window, by frozen acquisition rail; activation requires a committed booking in the window',
    cohort: { asOf: from.toISOString(), size: cohortSize,
      definition: 'users existing at window start who had already hosted an activity or booked a seat' },
    byRail: {
      vouch: rail(summary?.vouchAcquired ?? 0, summary?.vouchActivated ?? 0),
      public: rail(summary?.publicAcquired ?? 0, summary?.publicActivated ?? 0),
    },
    newUsersByGeneration: generations,
    target: null,
    note: 'No numerical K target is supplied; deeper descendants belong to their own later cohorts.',
    status: !cohortSize ? 'no_data' : 'observed',
  };
}

// Holdout outcomes per experiment version: every activity assigned inside the window,
// whether or not anyone was exposed or invited. Participants are current committed bookings
// at query time; a provisional formed plan is an activity with at least two of them. The
// difference is descriptive with a Welch-style interval, never a causal claim.
async function holdout(db: Database, parameters: unknown[]) {
  const arms = await rows<{ version: string; variant: 'treatment' | 'control'; activities: number; participants: number;
    sumSquares: number; formedPlans: number }>(db, `
    WITH assigned AS (
      SELECT e.version, e.variant, a.id, host.synthetic, host.test,
        (SELECT count(*) FROM bookings b WHERE b.activity_id=a.id)::integer AS participants
      FROM experiment_assignments e
      JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id
      WHERE e.assigned_at >= $2 AND e.assigned_at < $3
        AND ($1 OR NOT (host.synthetic OR host.test))
    )
    SELECT version, variant, count(*)::integer AS activities, sum(participants)::integer AS participants,
      sum(participants * participants)::integer AS "sumSquares",
      count(*) FILTER (WHERE participants >= 2)::integer AS "formedPlans"
    FROM assigned GROUP BY version, variant ORDER BY version, variant`, parameters);
  const byVersion = [];
  for (const version of new Set(arms.map(arm => arm.version))) {
    const treatment = arms.find(arm => arm.version === version && arm.variant === 'treatment');
    const control = arms.find(arm => arm.version === version && arm.variant === 'control');
    const arm = (row?: typeof treatment) => {
      const activities = row?.activities ?? 0;
      const participants = row?.participants ?? 0;
      return { activities, participants,
        meanParticipantsPerActivity: activities ? participants / activities : null,
        formedPlans: row?.formedPlans ?? 0,
        formedPlanRate: activities ? (row?.formedPlans ?? 0) / activities : null };
    };
    const treatmentArm = arm(treatment), controlArm = arm(control);
    const meanDifference = treatmentArm.meanParticipantsPerActivity !== null && controlArm.meanParticipantsPerActivity !== null
      ? treatmentArm.meanParticipantsPerActivity - controlArm.meanParticipantsPerActivity : null;
    const standardError = treatment && control && treatment.activities > 1 && control.activities > 1
      ? Math.sqrt(sampleVariance(treatment) / treatment.activities + sampleVariance(control) / control.activities)
      : null;
    byVersion.push({
      version,
      treatment: treatmentArm,
      control: controlArm,
      difference: {
        participantsPerActivity: meanDifference,
        participantsPerActivityCi95: meanDifference === null || standardError === null ? null
          : [meanDifference - 1.959963984540054 * standardError, meanDifference + 1.959963984540054 * standardError],
        formedPlanRate: treatmentArm.formedPlanRate !== null && controlArm.formedPlanRate !== null
          ? treatmentArm.formedPlanRate - controlArm.formedPlanRate : null,
      },
      attendance: 'unmeasured',
      includesUnexposed: true,
      observationalOnly: true,
      status: !treatment?.activities || !control?.activities ? 'no_data' : 'observed',
    });
  }
  return {
    experiment: 'group_invites_v1',
    basis: 'activities assigned in the window; participants are current committed bookings at query time',
    byVersion,
  };
}

function sampleVariance(arm: { activities: number; participants: number; sumSquares: number }) {
  return arm.activities > 1 ? (arm.sumSquares - arm.participants * arm.participants / arm.activities) / (arm.activities - 1) : 0;
}

// Wilson score interval: symmetric-ish bounds that stay inside [0,1] for small samples.
export function wilson95(successes: number, total: number): [number, number] {
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = successes / total;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const spread = (z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total))) / denominator;
  return [center - spread, center + spread];
}

interface OpenCount { opened: number; converted: number }

// Open-to-claim conversion over deduplicated (invite, journey) units. The headline keeps
// every human open including full/expired previews; the eligible rate excludes recovery
// reopens and previews the guest could not act on. Deadlines come from the view.
async function openToClaim(db: Database, parameters: unknown[], from: Date, to: Date) {
  const bound = [...parameters, to.toISOString()];
  const counts = async (condition: string): Promise<OpenCount> => {
    const [row] = await rows<OpenCount>(db, `
      SELECT count(*)::integer AS opened, count(*) FILTER (WHERE converted)::integer AS converted
      FROM metric_invite_open_units
      WHERE opened_at >= $2 AND opened_at < $3 AND claim_deadline <= $4 AND (${condition})
        AND ($1 OR NOT (synthetic OR test))`, bound);
    return row ?? { opened: 0, converted: 0 };
  };
  const [headline, eligible] = await Promise.all([
    counts('true'),
    counts("displayed_state='valid' AND NOT recovery"),
  ]);
  const [immature] = await rows<OpenCount>(db, `
    SELECT count(*)::integer AS opened, count(*) FILTER (WHERE converted)::integer AS converted
    FROM metric_invite_open_units
    WHERE opened_at >= $2 AND opened_at < $3 AND claim_deadline > $4
      AND ($1 OR NOT (synthetic OR test))`, bound);
  const by = async (dimension: string, eligibleOnly: boolean): Promise<Record<string, OpenCount>> => {
    const grouped = await rows<OpenCount & { key: string }>(db, `
      SELECT ${dimension} AS key, count(*)::integer AS opened, count(*) FILTER (WHERE converted)::integer AS converted
      FROM metric_invite_open_units
      WHERE opened_at >= $2 AND opened_at < $3 AND claim_deadline <= $4
        ${eligibleOnly ? "AND displayed_state='valid' AND NOT recovery" : ''}
        AND ($1 OR NOT (synthetic OR test))
      GROUP BY ${dimension} ORDER BY key`, bound);
    return Object.fromEntries(grouped.map(({ key, ...count }) => [key, count]));
  };
  const [byRail, byPlatform, byDisplayedState, viewer] = await Promise.all([
    by('rail', true), by('platform', true), by('displayed_state', false), by('actor_present', true),
  ]);
  const [recovery] = await rows<{ count: number }>(db, `
    SELECT count(*)::integer AS count FROM metric_invite_open_units
    WHERE opened_at >= $2 AND opened_at < $3 AND claim_deadline <= $4 AND recovery
      AND ($1 OR NOT (synthetic OR test))`, bound);
  const eligibleRate = eligible.opened ? eligible.converted / eligible.opened : null;
  return {
    definition: 'deduplicated (invite, guest journey) opens; conversion is an attributed claim by the earlier of 24h and activity start',
    headline: { openedJourneys: headline.opened, convertedJourneys: headline.converted,
      rate: headline.opened ? headline.converted / headline.opened : null },
    eligible: { eligibleOpens: eligible.opened, converted: eligible.converted, rate: eligibleRate,
      wilson95: eligibleRate === null ? null : wilson95(eligible.converted, eligible.opened) },
    notYetMature: { openedJourneys: immature?.opened ?? 0, convertedJourneys: immature?.converted ?? 0 },
    reasons: { byDisplayedState, recoveryOpens: recovery?.count ?? 0 },
    byRail, byPlatform,
    byAvailabilityAtOpen: byDisplayedState,
    byViewer: { new: viewer.false ?? { opened: 0, converted: 0 }, returning: viewer.true ?? { opened: 0, converted: 0 } },
    target: 0.25,
    trigger: { matureJourneys: 200 },
    status: !headline.opened ? 'no_data' : headline.opened < 200 ? 'insufficient_sample' : 'observed',
  };
}
