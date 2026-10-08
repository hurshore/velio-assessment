# Invitation assignments — issue #4

Scope: PLANS.md §§1.5, 2.7, 4.1 and 4.4. Node 24.21.0, PostgreSQL
17.6, real API requests using runtime credentials in disposable databases.

Focused checks:

- New activities persist their assignment before the response, without exposure.
- Restarting with a different version/allocation and creation disabled preserves
  existing assignment fields and timestamps; new activities use the new settings.
- Host and confirmed-booker creation eligibility is treatment-only, with the
  creation switch enforced. Anonymous/other actors do not qualify.
- Repeatable synthetic seeds cover treatment and control at 50% in `seed-3`.
  Ordinary booking succeeds in both; booking success carries stored assignment.
- Exposure events deduplicate by event ID and derive assignment from PostgreSQL.
  Client-supplied assignment fields are rejected. Runtime assignment updates and
  deletes fail. An injected assignment insertion failure rolls back activity/plan.
- Web renders treatment/control/disabled copy before recording exposure; loading
  emits none. StrictMode does not duplicate it, and failed delivery retries the
  original event while details remain readable.

Creation endpoint enforcement and issued invitation resolution/claims are reserved
for the public/vouch tickets. This ticket supplies `requireInviteCreation` as their
shared write policy. No production causal lift, sample sufficiency, or attendance
claim is made. Client telemetry remains best effort on refresh/closure as documented
for the existing delivery registry.

Final checks: `npm run typecheck` and `npm run build` passed. `npm test`
passed 12 root, 54 backend and 62 web tests, including the existing 50-request
capacity races. The five new PostgreSQL scenarios and four new web exposure
scenarios all passed. No tests were skipped.
Flutter analysis and all 13 mobile tests passed. Migration 005 and two consecutive
seed runs passed in the existing local database: all seven activities had one
assignment; the labelled fixtures retained `seed-3` treatment/control variants.
Standards and Spec reviews against the starting commit found no actionable issues.
