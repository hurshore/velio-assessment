import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { assignmentJson, type InvitePolicy } from './experiments.js';
import { bookingActor, bookSeat, recordInvalidBooking, type Actor, type BookingDatabase, type Intent } from './bookings.js';
import type { FailureReporter } from './diagnostics.js';
import { DomainError, exact, inviteCode, marker, object, platform, rows, text, uuid, type Database } from './domain.js';
import { absoluteTime } from './activities.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 32 divides 256, so mapping each random byte to the alphabet is unbiased.
function generateCode(): string {
  return [...randomBytes(12)].map(byte => alphabet[byte % 32]).join('');
}

export type PreviewState = 'valid' | 'full' | 'expired' | 'started' | 'cancelled';
export interface ResolvedInvite {
  id: string; activityId: string; planId: string; inviterId: string; rail: 'public'; inviterGeneration: number; state: PreviewState;
  preview: Record<string, unknown>;
}

// jsonb would otherwise render microsecond offsets; match the API's JSON Date form.
function isoTime(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// State precedence follows what a guest can act on: activity status first, then expiry, then capacity.
const previewState = `CASE WHEN a.status='cancelled' THEN 'cancelled'
  WHEN a.status<>'scheduled' OR a.starts_at <= clock_timestamp() THEN 'started'
  WHEN i.expires_at <= clock_timestamp() THEN 'expired'
  WHEN a.confirmed_count >= a.capacity THEN 'full' ELSE 'valid' END`;

export async function resolveInvite(db: Database, value: unknown): Promise<ResolvedInvite> {
  const code = inviteCode(value);
  const [invite] = await rows<ResolvedInvite>(db, `SELECT i.id, i.activity_id AS "activityId", i.plan_id AS "planId", i.inviter_id AS "inviterId",
    i.rail, i.inviter_generation AS "inviterGeneration", ${previewState} AS state,
    jsonb_build_object('code',i.code,'rail',i.rail,'trust',i.rail,'state',${previewState},'createdAt',${isoTime('i.created_at')},'expiresAt',${isoTime('i.expires_at')},
      'inviter',jsonb_build_object('displayName',u.display_name,'role',i.inviter_role),
      'activity',jsonb_build_object('id',a.id,'planId',i.plan_id,'title',a.title,'description',a.description,'meetingLocation',a.meeting_location,
        'startsAt',${isoTime('a.starts_at')},'timezone',a.timezone,'status',a.status,'capacity',a.capacity,'confirmedCount',a.confirmed_count,
        'remainingSeats',a.capacity-a.confirmed_count,'priceMinor',a.price_minor,'currency',a.currency,'version',a.version)) AS preview
    FROM invites i JOIN activities a ON a.id=i.activity_id JOIN users u ON u.id=i.inviter_id WHERE i.code=$1`, [code]);
  if (!invite) throw new DomainError(404, 'INVALID_INVITE', 'This invitation code is not valid. Check the code and try again.');
  return invite;
}

const previewStates = ['valid', 'full', 'expired', 'started', 'cancelled'];
// A rendered human open, reported by a client after the preview is visible. The displayed state
// is what the guest saw; the server separately records the authoritative state at receipt.
export async function recordInviteOpen(db: Database, body: Record<string, unknown>, actorHeader: string | undefined) {
  exact(body, ['id', 'schemaVersion', 'name', 'occurredAt', 'source', 'platform', 'actorId', 'journeyId', 'inviteCode', 'displayedState', 'synthetic', 'test']);
  const eventId = uuid(body.id, 'Event');
  const journeyId = uuid(body.journeyId, 'Journey');
  if (typeof body.displayedState !== 'string' || !previewStates.includes(body.displayedState)) {
    throw new DomainError(400, 'INVALID_REQUEST', 'Invite opens require the displayed preview state.');
  }
  if (body.actorId !== undefined && body.actorId !== actorHeader) throw new DomainError(400, 'INVALID_REQUEST', 'Event actor must match the selected demo identity.');
  const actor = actorHeader ? uuid(actorHeader, 'Identity').toLowerCase() : null;
  if (actor && !(await rows(db, 'SELECT 1 FROM users WHERE id=$1', [actor])).length) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Selected demo identity was not found.');
  const invite = await resolveInvite(db, body.inviteCode);
  const inserted = await rows(db, `INSERT INTO analytics_events
    (id,schema_version,name,occurred_at,source,platform,actor_id,journey_id,activity_id,plan_id,invite_id,context,synthetic,test)
    SELECT $1,1,'invite_opened',$2,'client',$3,$4,$5,i.activity_id,i.plan_id,i.id,
      jsonb_build_object('rail',i.rail,'inviterRole',i.inviter_role,'inviterGeneration',i.inviter_generation,'displayedState',$6::text,
        'stateAtReceipt',${previewState},
        'recovery',EXISTS (SELECT 1 FROM bookings b WHERE b.activity_id=i.activity_id AND b.user_id=$4),
        'assignment',(SELECT ${assignmentJson('e')} FROM experiment_assignments e WHERE e.activity_id=i.activity_id))
        || CASE WHEN viewer.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('generation',viewer.generation) END,
      $7 OR inviter.synthetic OR host.synthetic OR COALESCE(viewer.synthetic,false), $8 OR inviter.test OR host.test OR COALESCE(viewer.test,false)
    FROM invites i JOIN activities a ON a.id=i.activity_id JOIN users inviter ON inviter.id=i.inviter_id JOIN users host ON host.id=a.host_id
    LEFT JOIN users viewer ON viewer.id=$4 WHERE i.id=$9
    ON CONFLICT (id) DO NOTHING RETURNING id`, [eventId, absoluteTime(body.occurredAt), platform(body.platform), actor, journeyId,
    body.displayedState, marker(body.synthetic), marker(body.test), invite.id]);
  return { id: eventId, accepted: inserted.length === 1 };
}

// Resolution is a read: link-preview crawlers and prefetches never count as human opens.
export function inviteRoutes(db: BookingDatabase, logFailure: FailureReporter) {
  const router = Router();
  router.get('/:code', async (request, response) => {
    response.json({ data: (await resolveInvite(db, request.params.code)).preview, requestId: response.locals.requestId });
  });
  // Claims honor issued, unexpired invites regardless of the creation switch or later assignment changes.
  router.post('/:code/claims', async (request, response) => {
    let intent: Intent;
    let user: Actor;
    let invite: ResolvedInvite | undefined;
    try {
      invite = await resolveInvite(db, request.params.code);
      user = await bookingActor(db, request.get('X-Demo-Actor-Id'));
      const body = object(request.body);
      exact(body, ['platform', 'journeyId']);
      intent = { operation: 'claim_invite', actorId: user.id, activityId: invite.activityId, key: text(request.get('Idempotency-Key'), 'Idempotency key', 128),
        platform: platform(body.platform), journeyId: uuid(body.journeyId, 'Journey'), requestId: response.locals.requestId,
        invite: { id: invite.id, inviterId: invite.inviterId, rail: invite.rail } };
    } catch (error) {
      await recordInvalidBooking(db, { requestId: response.locals.requestId, actorId: request.get('X-Demo-Actor-Id'), activityId: invite?.activityId,
        inviteId: invite?.id, operation: 'claim_invite', code: error instanceof DomainError ? error.code : 'TECHNICAL_ERROR', technical: !(error instanceof DomainError) }, logFailure);
      throw error;
    }
    const result = await bookSeat(db, intent, user, logFailure);
    response.status(result.replayed ? 200 : 201).json({ data: result, requestId: response.locals.requestId });
  });
  return router;
}

function actorId(value: string | undefined, purpose: string): string {
  if (!value) throw new DomainError(401, 'IDENTITY_REQUIRED', `Select a demo identity before ${purpose}.`);
  return uuid(value, 'Identity').toLowerCase();
}

export function inviteCreationRoutes(db: Database, policy: InvitePolicy) {
  const router = Router();
  router.post('/:id/invites', async (request, response) => {
    const inviter = actorId(request.get('X-Demo-Actor-Id'), 'sharing');
    const activityId = uuid(request.params.id, 'Activity').toLowerCase();
    const body = object(request.body);
    exact(body, ['rail', 'platform', 'journeyId']);
    if (body.rail !== 'public') throw new DomainError(400, 'INVALID_REQUEST', 'Only public share links can be created.');
    const source = platform(body.platform);
    const journeyId = body.journeyId === undefined ? null : uuid(body.journeyId, 'Journey');
    await policy.requireCreation(activityId, inviter);
    const [state] = await rows<{ status: string; started: boolean; remaining: number }>(db, `SELECT status,
      starts_at <= clock_timestamp() AS started, capacity-confirmed_count AS remaining FROM activities WHERE id=$1`, [activityId]);
    if (state!.status !== 'scheduled') throw new DomainError(409, 'ACTIVITY_UNAVAILABLE', 'This activity is no longer bookable, so it cannot be shared.');
    if (state!.started) throw new DomainError(409, 'ACTIVITY_STARTED', 'This activity has already started, so it cannot be shared.');
    if (state!.remaining === 0) throw new DomainError(409, 'SOLD_OUT', 'No seats remain to share.');
    // A code collision is astronomically unlikely; retrying keeps uniqueness database-enforced.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [invite] = await rows(db, `WITH invite AS (
        INSERT INTO invites (id,code,activity_id,plan_id,inviter_id,inviter_role,rail,inviter_generation,inviter_parent_id,inviter_root_id,invitee_generation,created_at,expires_at)
        SELECT $1,$2,a.id,p.id,u.id,CASE WHEN a.host_id=u.id THEN 'host' ELSE 'booker' END,'public',
          u.generation,u.acquisition_parent_id,u.acquisition_root_id,u.generation+1,
          date_trunc('milliseconds', now()),LEAST(date_trunc('milliseconds', now()) + interval '24 hours', a.starts_at)
        FROM activities a JOIN plans p ON p.activity_id=a.id JOIN users u ON u.id=$3 WHERE a.id=$4
        ON CONFLICT (code) DO NOTHING RETURNING *
      ), event AS (
        INSERT INTO analytics_events (id,schema_version,name,occurred_at,source,platform,actor_id,journey_id,activity_id,plan_id,invite_id,context,synthetic,test)
        SELECT $5,1,'invite_created',now(),'server',$6,i.inviter_id,$7,i.activity_id,i.plan_id,i.id,
          jsonb_build_object('operation','create_invite','rail',i.rail,'inviterRole',i.inviter_role,'generation',i.inviter_generation,
            'inviterRootId',i.inviter_root_id,'expiresAt',${isoTime('i.expires_at')},
            'assignment',(SELECT ${assignmentJson('e')} FROM experiment_assignments e WHERE e.activity_id=i.activity_id)),
          u.synthetic OR host.synthetic, u.test OR host.test
        FROM invite i JOIN users u ON u.id=i.inviter_id JOIN activities a ON a.id=i.activity_id JOIN users host ON host.id=a.host_id
      ) SELECT i.id, i.code, i.rail, i.inviter_role AS "inviterRole", i.activity_id AS "activityId", i.plan_id AS "planId",
        i.created_at AS "createdAt", i.expires_at AS "expiresAt",
        jsonb_build_object('capacity',a.capacity,'confirmedCount',a.confirmed_count,'remainingSeats',a.capacity-a.confirmed_count,'version',a.version) AS availability
      FROM invite i JOIN activities a ON a.id=i.activity_id`, [randomUUID(), generateCode(), inviter, activityId, randomUUID(), source, journeyId]);
      if (invite) {
        response.status(201).json({ data: invite, requestId: response.locals.requestId });
        return;
      }
    }
    throw new Error('Could not allocate a unique invite code');
  });
  return router;
}
