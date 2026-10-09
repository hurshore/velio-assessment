import { Router } from 'express';
import { rows, type Database } from './domain.js';
import type { BookingDatabase } from './bookings.js';
import {
  bookerInviteTarget, bookerMinMatureJourneys, formedPlanMinParticipants, inviteWindowHours, kWindowDays,
  openClaimTarget, openMinMatureJourneys, sampleStatus, wilson95, z95,
} from './metric-policy.js';
import { parseReportingWindow, unmarked, windowParameters, withReportSnapshot, type ReportingWindow } from './reporting.js';

export function productRoutes(db: BookingDatabase) {
  const router = Router();
  router.get('/product', async (request, response) => {
    const window = parseReportingWindow(request.query as Record<string, unknown>);
    // Sequential blocks inside one snapshot: a single pooled connection per report.
    const data = await withReportSnapshot(db, async snapshot => ({
      includeTest: window.includeTest,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      bookersInvite: await bookersInvite(snapshot, window),
      openToClaim: await openToClaim(snapshot, window),
      kFactor: await kFactor(snapshot, window),
      holdout: await holdout(snapshot, window),
      scope: 'Local measurements with stated samples; not production attainment.',
    }));
    response.json({ data, requestId: response.locals.requestId });
  });
  return router;
}

// Each booker's first confirmed booking in the window qualifies; they invited when they
// themselves created an invite for that activity within the invite window. Maturity is judged
// against the window end ($4), so a re-run report does not change as time passes.
async function bookersInvite(db: Database, window: ReportingWindow) {
  const [row] = await rows<{ matureQualifying: number; matureInvited: number; immatureQualifying: number; immatureInvited: number;
    invitedVouch: number; invitedPublic: number; hostCreators: number; bySignupGeneration: Record<string, unknown> }>(db, `
    WITH eligible AS (
      SELECT b.id, b.user_id, b.activity_id, b.confirmed_at FROM bookings b
      JOIN users u ON u.id=b.user_id JOIN activities a ON a.id=b.activity_id JOIN users host ON host.id=a.host_id
      WHERE b.confirmed_at >= $2 AND b.confirmed_at < $3 AND ${unmarked('u', 'host')}
    ), first_bookings AS (
      SELECT DISTINCT ON (user_id) user_id, activity_id, confirmed_at FROM eligible ORDER BY user_id, confirmed_at, id
    ), qualified AS (
      SELECT fb.*, fb.confirmed_at + interval '${inviteWindowHours} hours' <= $4 AS mature, inv.rail, u.generation
      FROM first_bookings fb JOIN users u ON u.id=fb.user_id
      LEFT JOIN LATERAL (SELECT i.rail FROM invites i WHERE i.inviter_id=fb.user_id AND i.activity_id=fb.activity_id
        AND i.created_at >= fb.confirmed_at AND i.created_at <= fb.confirmed_at + interval '${inviteWindowHours} hours'
        ORDER BY i.created_at, i.id LIMIT 1) inv ON true
    ), host_creators AS (
      SELECT count(DISTINCT i.inviter_id)::integer AS creators FROM invites i
      JOIN users inviter ON inviter.id=i.inviter_id JOIN activities a ON a.id=i.activity_id JOIN users host ON host.id=a.host_id
      WHERE i.inviter_role='host' AND i.created_at >= $2 AND i.created_at < $3 AND ${unmarked('inviter', 'host')}
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id=i.inviter_id AND b.confirmed_at < $3)
    ), by_generation AS (
      SELECT COALESCE(jsonb_object_agg(generation, jsonb_build_object('qualifyingBookers', qualifying, 'invitedWithin24h', invited)), '{}') AS segments
      FROM (SELECT generation, count(*)::integer AS qualifying, count(*) FILTER (WHERE rail IS NOT NULL)::integer AS invited
        FROM qualified WHERE mature GROUP BY generation) g
    )
    SELECT count(*) FILTER (WHERE mature)::integer AS "matureQualifying",
      count(*) FILTER (WHERE mature AND rail IS NOT NULL)::integer AS "matureInvited",
      count(*) FILTER (WHERE NOT mature)::integer AS "immatureQualifying",
      count(*) FILTER (WHERE NOT mature AND rail IS NOT NULL)::integer AS "immatureInvited",
      count(*) FILTER (WHERE mature AND rail='vouch')::integer AS "invitedVouch",
      count(*) FILTER (WHERE mature AND rail='public')::integer AS "invitedPublic",
      (SELECT creators FROM host_creators) AS "hostCreators",
      (SELECT segments FROM by_generation) AS "bySignupGeneration"
    FROM qualified`, [...windowParameters(window), window.to.toISOString()]);
  const qualifying = row?.matureQualifying ?? 0;
  const invited = row?.matureInvited ?? 0;
  const rate = qualifying ? invited / qualifying : null;
  return {
    definition: `each user's first confirmed booking in the window; they invited when they created an invite for that activity within ${inviteWindowHours}h`,
    mature: { qualifyingBookers: qualifying, invitedWithin24h: invited, rate,
      wilson95: rate === null ? null : wilson95(invited, qualifying),
      invitedByRail: { vouch: row?.invitedVouch ?? 0, public: row?.invitedPublic ?? 0 },
      bySignupGeneration: row?.bySignupGeneration ?? {} },
    notYetMature: { qualifyingBookers: row?.immatureQualifying ?? 0, invitedWithin24h: row?.immatureInvited ?? 0 },
    hostCreatorsWithoutBooking: row?.hostCreators ?? 0,
    target: bookerInviteTarget,
    trigger: { matureBookerJourneys: bookerMinMatureJourneys },
    status: sampleStatus(qualifying, bookerMinMatureJourneys),
  };
}

interface OpenCount { opened: number; converted: number }
interface OpenReport {
  headline: OpenCount; eligible: OpenCount; immature: OpenCount; recovery: OpenCount;
  byRail: Record<string, OpenCount>; byPlatform: Record<string, OpenCount>; byInviterGeneration: Record<string, OpenCount>;
  byViewer: Record<string, OpenCount>; byDisplayedState: Record<string, OpenCount>;
}

// Open-to-claim over deduplicated (invite, journey) units from metric_invite_open_units, whose
// timing policy is documented in migration 012. The view is evaluated once per report; every
// count and segment below aggregates that materialized set. Recovery reopens by existing
// bookers are not acquisition: they are counted separately and never enter a rate.
async function openToClaim(db: Database, window: ReportingWindow) {
  const headlineUnits = 'mature AND NOT recovery';
  const eligibleUnits = "mature AND NOT recovery AND displayed_state='valid'";
  const total = (condition: string) => `(SELECT jsonb_build_object('opened', count(*)::integer,
    'converted', count(*) FILTER (WHERE converted)::integer) FROM units WHERE ${condition})`;
  const segment = (key: string, condition: string) => `(SELECT COALESCE(jsonb_object_agg(key,
    jsonb_build_object('opened', opened, 'converted', converted)), '{}'::jsonb)
    FROM (SELECT (${key})::text AS key, count(*)::integer AS opened, count(*) FILTER (WHERE converted)::integer AS converted
      FROM units WHERE ${condition} GROUP BY 1) grouped)`;
  const [row] = await rows<{ report: OpenReport }>(db, `
    WITH units AS MATERIALIZED (
      SELECT converted, recovery, displayed_state, rail, platform, inviter_generation, actor_present, claim_deadline <= $4 AS mature
      FROM metric_invite_open_units
      WHERE opened_at >= $2 AND opened_at < $3 AND ${unmarked('')}
    )
    SELECT jsonb_build_object(
      'headline', ${total(headlineUnits)},
      'eligible', ${total(eligibleUnits)},
      'immature', ${total('NOT mature AND NOT recovery')},
      'recovery', ${total('mature AND recovery')},
      'byRail', ${segment('rail', eligibleUnits)},
      'byPlatform', ${segment('platform', eligibleUnits)},
      'byInviterGeneration', ${segment('inviter_generation', eligibleUnits)},
      -- A viewer who already had an identity at first open is a returning user.
      'byViewer', ${segment("CASE WHEN actor_present THEN 'returning' ELSE 'new' END", eligibleUnits)},
      'byDisplayedState', ${segment('displayed_state', headlineUnits)}
    ) AS report`, [...windowParameters(window), window.to.toISOString()]);
  const report = row!.report;
  const empty: OpenCount = { opened: 0, converted: 0 };
  const eligibleRate = report.eligible.opened ? report.eligible.converted / report.eligible.opened : null;
  return {
    definition: `deduplicated (invite, guest journey) opens excluding recovery reopens; conversion is an attributed claim by the earlier of ${inviteWindowHours}h and activity start`,
    headline: { openedJourneys: report.headline.opened, convertedJourneys: report.headline.converted,
      rate: report.headline.opened ? report.headline.converted / report.headline.opened : null },
    eligible: { eligibleOpens: report.eligible.opened, converted: report.eligible.converted, rate: eligibleRate,
      wilson95: eligibleRate === null ? null : wilson95(report.eligible.converted, report.eligible.opened) },
    notYetMature: { openedJourneys: report.immature.opened, convertedJourneys: report.immature.converted },
    reasons: { byDisplayedState: report.byDisplayedState, recoveryOpens: report.recovery.opened },
    byRail: report.byRail, byPlatform: report.byPlatform, byInviterGeneration: report.byInviterGeneration,
    byAvailabilityAtOpen: report.byDisplayedState,
    byViewer: { new: report.byViewer.new ?? empty, returning: report.byViewer.returning ?? empty },
    target: openClaimTarget,
    trigger: { matureJourneys: openMinMatureJourneys },
    status: sampleStatus(report.headline.opened, openMinMatureJourneys),
  };
}

// K by frozen acquisition rail. The cohort is every unmarked user existing at window start who
// had already hosted or booked (non-inviters included). A new user counts only when their
// frozen acquisition parent is in that cohort, so marked parents and window-acquired inviters
// never contribute; descendants appear only in the generation breakdown. Activation is an
// invitation claim (redemption edge) inside the window, not any booking.
async function kFactor(db: Database, window: ReportingWindow) {
  const parameters = windowParameters(window);
  const [summary] = await rows<{ cohortSize: number; vouchAcquired: number; vouchActivated: number;
    publicAcquired: number; publicActivated: number }>(db, `
    WITH cohort AS (
      SELECT u.id FROM users u
      WHERE u.created_at < $2 AND ${unmarked('u')}
        AND (EXISTS (SELECT 1 FROM activities a WHERE a.host_id=u.id AND a.created_at < $2)
          OR EXISTS (SELECT 1 FROM bookings b WHERE b.user_id=u.id AND b.confirmed_at < $2))
    ), acquired AS (
      SELECT n.id, n.acquisition_rail AS rail,
        EXISTS (SELECT 1 FROM invite_redemptions r WHERE r.invitee_id=n.id AND r.created_at >= n.created_at AND r.created_at < $3) AS activated
      FROM users n JOIN cohort c ON c.id=n.acquisition_parent_id
      WHERE n.created_at >= $2 AND n.created_at < $3 AND n.acquisition_rail IS NOT NULL AND ${unmarked('n')}
    )
    SELECT (SELECT count(*)::integer FROM cohort) AS "cohortSize",
      count(*) FILTER (WHERE rail='vouch')::integer AS "vouchAcquired",
      count(*) FILTER (WHERE rail='vouch' AND activated)::integer AS "vouchActivated",
      count(*) FILTER (WHERE rail='public')::integer AS "publicAcquired",
      count(*) FILTER (WHERE rail='public' AND activated)::integer AS "publicActivated"
    FROM acquired`, parameters);
  // A marked acquisition parent marks the lineage even when its descendant row is unmarked.
  const generations = await rows<{ generation: number; users: number }>(db, `
    SELECT n.generation, count(*)::integer AS users FROM users n
    LEFT JOIN users parent ON parent.id=n.acquisition_parent_id
    WHERE n.created_at >= $2 AND n.created_at < $3 AND ${unmarked('n')}
      AND ($1 OR NOT (COALESCE(parent.synthetic, false) OR COALESCE(parent.test, false)))
    GROUP BY n.generation ORDER BY n.generation`, parameters);
  const cohortSize = summary?.cohortSize ?? 0;
  const days = (window.to.getTime() - window.from.getTime()) / 86_400_000;
  const rail = (acquired: number, activated: number) => ({
    acquired, activated,
    k: cohortSize ? acquired / cohortSize : null,
    activatedK: cohortSize ? activated / cohortSize : null,
  });
  return {
    definition: 'distinct new users directly acquired by the fixed cohort within the window, by frozen acquisition rail; activation requires an invitation claim in the window',
    window: { days, planned: kWindowDays },
    cohort: { asOf: window.from.toISOString(), size: cohortSize,
      definition: 'unmarked users existing at window start who had already hosted an activity or booked a seat' },
    byRail: {
      vouch: rail(summary?.vouchAcquired ?? 0, summary?.vouchActivated ?? 0),
      public: rail(summary?.publicAcquired ?? 0, summary?.publicActivated ?? 0),
    },
    newUsersByGeneration: generations,
    target: null,
    note: 'No numerical K target is supplied; deeper descendants belong to their own later cohorts.',
    // The plan observes a seven-day window; shorter windows are labelled rather than refused.
    status: !cohortSize ? 'no_data' : days < kWindowDays ? 'partial_window' : 'observed',
  };
}

interface HoldoutArm { version: string; variant: 'treatment' | 'control'; activities: number; participants: number; sumSquares: number; formedPlans: number }

// Holdout outcomes per experiment version: every activity assigned inside the window whose
// host is unmarked, whether or not anyone was exposed or invited. Participants are unmarked
// bookers confirmed before the window ends, so an assigned activity with no qualifying
// participant still stays in its arm's denominator. The difference is descriptive with a
// Welch-style interval, never a causal claim.
async function holdout(db: Database, window: ReportingWindow) {
  const arms = await rows<HoldoutArm>(db, `
    WITH assigned AS (
      SELECT e.version, e.variant,
        (SELECT count(*) FROM bookings b JOIN users p ON p.id=b.user_id
          WHERE b.activity_id=a.id AND b.confirmed_at < $3 AND ${unmarked('p')})::integer AS participants
      FROM experiment_assignments e
      JOIN activities a ON a.id=e.activity_id JOIN users host ON host.id=a.host_id
      WHERE e.assigned_at >= $2 AND e.assigned_at < $3 AND ${unmarked('host')}
    )
    SELECT version, variant, count(*)::integer AS activities, sum(participants)::integer AS participants,
      sum(participants * participants)::integer AS "sumSquares",
      count(*) FILTER (WHERE participants >= ${formedPlanMinParticipants})::integer AS "formedPlans"
    FROM assigned GROUP BY version, variant ORDER BY version, variant`, windowParameters(window));
  const byVersion = [...new Set(arms.map(arm => arm.version))].map(version => {
    const treatment = arms.find(arm => arm.version === version && arm.variant === 'treatment');
    const control = arms.find(arm => arm.version === version && arm.variant === 'control');
    const treatmentArm = summariseArm(treatment);
    const controlArm = summariseArm(control);
    const meanDifference = treatmentArm.meanParticipantsPerActivity !== null && controlArm.meanParticipantsPerActivity !== null
      ? treatmentArm.meanParticipantsPerActivity - controlArm.meanParticipantsPerActivity : null;
    const standardError = treatment && control && treatment.activities > 1 && control.activities > 1
      ? Math.sqrt(sampleVariance(treatment) / treatment.activities + sampleVariance(control) / control.activities)
      : null;
    return {
      version,
      treatment: treatmentArm,
      control: controlArm,
      difference: {
        participantsPerActivity: meanDifference,
        participantsPerActivityCi95: meanDifference === null || standardError === null ? null
          : [meanDifference - z95 * standardError, meanDifference + z95 * standardError],
        formedPlanRate: treatmentArm.formedPlanRate !== null && controlArm.formedPlanRate !== null
          ? treatmentArm.formedPlanRate - controlArm.formedPlanRate : null,
      },
      attendance: 'unmeasured',
      includesUnexposed: true,
      observationalOnly: true,
      status: !treatment?.activities || !control?.activities ? 'no_data' : 'observed',
    };
  });
  return {
    experiment: 'group_invites_v1',
    basis: `activities assigned in the window; participants are unmarked bookers confirmed before the window ends; formed plans have at least ${formedPlanMinParticipants}`,
    byVersion,
  };
}

function summariseArm(row?: HoldoutArm) {
  const activities = row?.activities ?? 0;
  const participants = row?.participants ?? 0;
  const formedPlans = row?.formedPlans ?? 0;
  return { activities, participants, formedPlans,
    meanParticipantsPerActivity: activities ? participants / activities : null,
    formedPlanRate: activities ? formedPlans / activities : null };
}

function sampleVariance(arm: HoldoutArm) {
  return arm.activities > 1 ? (arm.sumSquares - arm.participants * arm.participants / arm.activities) / (arm.activities - 1) : 0;
}
