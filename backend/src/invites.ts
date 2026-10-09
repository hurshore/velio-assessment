import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { assignmentJson, type InvitePolicy } from './experiments.js';
import { bookingActor, bookSeat, recordInvalidBooking, requestPlatform, type Actor, type BookingDatabase, type Intent, type LiveHooks } from './bookings.js';
import type { FailureReporter } from './diagnostics.js';
import { contact, DomainError, exact, marker, object, platform, rows, text, uuid, type Database } from './domain.js';
import { inviteStateSql, previewStates, rejectRecipient, rejectUnavailableActivity, type PreviewState } from './invite-state.js';
import { absoluteTime } from './activities.js';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 32 divides 256, so mapping each random byte to the alphabet is unbiased.
function generateCode(): string {
  return [...randomBytes(12)].map(byte => alphabet[byte % 32]).join('');
}

export interface ResolvedInvite {
  id: string; activityId: string; planId: string; inviterId: string; rail: 'public' | 'vouch'; inviterGeneration: number; state: PreviewState;
  // Server-side only: matched against the claimant and never placed in the public preview.
  recipientContact: string | null;
  preview: Record<string, unknown>;
}

function invalidInvite(): never {
  throw new DomainError(404, 'INVALID_INVITE', 'This invitation code is not valid. Check the code and try again.');
}
// Accepts the grouped/lowercase forms people type from a shared message.
export function inviteCode(value: unknown): string {
  const code = typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(code)) invalidInvite();
  return code;
}

// jsonb would otherwise render microsecond offsets; match the API's JSON Date form.
function isoTime(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// One observation time per statement; see inviteStateSql for precedence.
const observedState = `CROSS JOIN LATERAL (SELECT clock_timestamp() AS observed_at) o
  CROSS JOIN LATERAL (SELECT ${inviteStateSql('o.observed_at')} AS state) s`;

export async function resolveInvite(db: Database, value: unknown): Promise<ResolvedInvite> {
  const code = inviteCode(value);
  const [invite] = await rows<ResolvedInvite>(db, `SELECT i.id, i.activity_id AS "activityId", i.plan_id AS "planId", i.inviter_id AS "inviterId",
    i.rail, i.inviter_generation AS "inviterGeneration", i.recipient_contact AS "recipientContact", s.state,
    jsonb_build_object('code',i.code,'rail',i.rail,'trust',i.rail,'state',s.state,'createdAt',${isoTime('i.created_at')},'expiresAt',${isoTime('i.expires_at')},
      'inviter',jsonb_build_object('displayName',u.display_name,'role',i.inviter_role),
      'activity',jsonb_build_object('id',a.id,'planId',i.plan_id,'title',a.title,'description',a.description,'meetingLocation',a.meeting_location,
        'startsAt',${isoTime('a.starts_at')},'timezone',a.timezone,'status',a.status,'capacity',a.capacity,'confirmedCount',a.confirmed_count,
        'remainingSeats',a.capacity-a.confirmed_count,'priceMinor',a.price_minor,'currency',a.currency,'version',a.version)) AS preview
    FROM invites i JOIN activities a ON a.id=i.activity_id JOIN users u ON u.id=i.inviter_id ${observedState} WHERE i.code=$1`, [code]);
  if (!invite) invalidInvite();
  return invite;
}

// Only a live issued link stamps signup acquisition. A full link still does: signup is not
// activation. Unusable links are rejected with the same codes a claim would return.
export async function signupInviteId(db: Database, code: unknown, signupContact: string | null): Promise<string> {
  const invite = await resolveInvite(db, code);
  rejectUnavailableActivity(invite.state, 'continue without the invitation');
  // A vouch credits acquisition only to its intended contact, matched like a claim.
  if (invite.rail === 'vouch' && signupContact !== invite.recipientContact) rejectRecipient('continue without the invitation');
  if (invite.state === 'expired') throw new DomainError(410, 'INVITE_EXPIRED', 'This invitation has expired. Continue without it or ask for a new link.');
  return invite.id;
}

// A rendered human open, reported by a client after the preview is visible. The displayed state
// is what the guest saw; the server separately records the authoritative state at receipt.
export async function recordInviteOpen(db: Database, body: Record<string, unknown>, actorHeader: string | undefined) {
  exact(body, ['id', 'schemaVersion', 'name', 'occurredAt', 'source', 'platform', 'actorId', 'journeyId', 'inviteCode', 'displayedState', 'synthetic', 'test']);
  const eventId = uuid(body.id, 'Event');
  const journeyId = uuid(body.journeyId, 'Journey');
  if (!previewStates.includes(body.displayedState as PreviewState)) {
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
        'stateAtReceipt',s.state,
        'recovery',EXISTS (SELECT 1 FROM bookings b WHERE b.activity_id=i.activity_id AND b.user_id=$4),
        'assignment',(SELECT ${assignmentJson('e')} FROM experiment_assignments e WHERE e.activity_id=i.activity_id))
        || CASE WHEN viewer.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('generation',viewer.generation) END,
      $7 OR inviter.synthetic OR host.synthetic OR COALESCE(viewer.synthetic,false), $8 OR inviter.test OR host.test OR COALESCE(viewer.test,false)
    FROM invites i JOIN activities a ON a.id=i.activity_id JOIN users inviter ON inviter.id=i.inviter_id JOIN users host ON host.id=a.host_id
    LEFT JOIN users viewer ON viewer.id=$4 ${observedState} WHERE i.id=$9
    ON CONFLICT (id) DO NOTHING RETURNING id`, [eventId, absoluteTime(body.occurredAt), platform(body.platform), actor, journeyId,
    body.displayedState, marker(body.synthetic), marker(body.test), invite.id]);
  return { id: eventId, accepted: inserted.length === 1 };
}

// Resolution is a read: link-preview crawlers and prefetches never count as human opens.
export function inviteRoutes(db: BookingDatabase, logFailure: FailureReporter, live: LiveHooks = {}) {
  const router = Router();
  router.get('/:code', async (request, response) => {
    response.json({ data: (await resolveInvite(db, request.params.code)).preview, requestId: response.locals.requestId });
  });
  router.get('/:code/recipient-check', async (request, response) => {
    const actor = await bookingActor(db, request.get('X-Demo-Actor-Id'), 'selecting an identity');
    const invite = await resolveInvite(db, request.params.code);
    const [match] = await rows<{ matches: boolean }>(db,
      'SELECT contact IS NOT NULL AND contact=$2 AS matches FROM users WHERE id=$1', [actor.id, invite.recipientContact]);
    response.json({ data: { matches: invite.rail === 'public' || match?.matches === true }, requestId: response.locals.requestId });
  });
  // Claims honor issued, unexpired invites regardless of the creation switch or later assignment changes.
  router.post('/:code/claims', async (request, response) => {
    const completed = live.workStarted?.();
    try {
      let intent: Intent;
      let user: Actor;
      let invite: ResolvedInvite | undefined;
      // Same validation order as direct booking: identity, then request shape, then the target.
      try {
        user = await bookingActor(db, request.get('X-Demo-Actor-Id'), 'claiming a seat');
        const body = object(request.body);
        exact(body, ['platform', 'journeyId']);
        const key = text(request.get('Idempotency-Key'), 'Idempotency key', 128);
        const source = platform(body.platform);
        const journeyId = uuid(body.journeyId, 'Journey');
        invite = await resolveInvite(db, request.params.code);
        intent = { operation: 'claim_invite', actorId: user.id, activityId: invite.activityId, key, platform: source, journeyId, requestId: response.locals.requestId,
          invite: { id: invite.id, inviterId: invite.inviterId, rail: invite.rail } };
      } catch (error) {
        // Attach invite context to the invalid outcome whenever the code itself resolves.
        invite ??= await resolveInvite(db, request.params.code).catch(() => undefined);
        await recordInvalidBooking(db, { requestId: response.locals.requestId, actorId: request.get('X-Demo-Actor-Id'), activityId: invite?.activityId,
          inviteId: invite?.id, operation: 'claim_invite', platform: requestPlatform(request.body),
          code: error instanceof DomainError ? error.code : 'TECHNICAL_ERROR', technical: !(error instanceof DomainError) }, logFailure);
        throw error;
      }
      const result = await bookSeat(db, intent, user, logFailure, live.committed, live.processId);
      response.status(result.replayed ? 200 : 201).json({ data: result, requestId: response.locals.requestId });
    } finally { completed?.(); }
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
    exact(body, ['rail', 'recipientContact', 'platform', 'journeyId']);
    if (body.rail !== 'public' && body.rail !== 'vouch') throw new DomainError(400, 'INVALID_REQUEST', 'Rail must be vouch or public.');
    const rail = body.rail;
    if (rail === 'public' && body.recipientContact !== undefined) throw new DomainError(400, 'INVALID_REQUEST', 'Public links have no intended recipient.');
    const recipient = rail === 'vouch' ? contact(body.recipientContact, 'Recipient contact') : null;
    const source = platform(body.platform);
    const journeyId = body.journeyId === undefined ? null : uuid(body.journeyId, 'Journey');
    await policy.requireCreation(activityId, inviter);
    if (recipient && (await rows(db, 'SELECT 1 FROM users WHERE id=$1 AND contact=$2', [inviter, recipient])).length) {
      throw new DomainError(403, 'SELF_INVITE', 'You cannot vouch for your own contact.');
    }
    // Eligibility and the insert share one statement and one observation time, so an activity
    // starting or filling mid-request yields its domain error rather than a constraint failure.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [outcome] = await rows<{ state: PreviewState; planned: boolean; invite: Record<string, unknown> | null }>(db, `WITH target AS (
        SELECT a.id, a.host_id, a.status, a.starts_at, a.capacity, a.confirmed_count, a.version, p.id AS plan_id,
          date_trunc('milliseconds', now()) AS created_at, host.synthetic AS host_synthetic, host.test AS host_test
        FROM activities a JOIN users host ON host.id=a.host_id LEFT JOIN plans p ON p.activity_id=a.id WHERE a.id=$4
      ), classified AS (
        SELECT t.*, CASE WHEN t.status='cancelled' THEN 'cancelled' WHEN t.status<>'scheduled' OR t.starts_at <= t.created_at THEN 'started'
          WHEN t.confirmed_count >= t.capacity THEN 'full' ELSE 'valid' END AS state FROM target t
      ), invite AS (
        INSERT INTO invites (id,code,activity_id,plan_id,inviter_id,inviter_role,rail,recipient_contact,inviter_generation,inviter_parent_id,inviter_root_id,invitee_generation,created_at,expires_at)
        SELECT $1,$2,t.id,t.plan_id,u.id,CASE WHEN t.host_id=u.id THEN 'host' ELSE 'booker' END,$8,$9,
          u.generation,u.acquisition_parent_id,u.acquisition_root_id,u.generation+1,t.created_at,LEAST(t.created_at + interval '24 hours', t.starts_at)
        FROM classified t JOIN users u ON u.id=$3 WHERE t.state='valid' AND t.plan_id IS NOT NULL
        ON CONFLICT (code) DO NOTHING RETURNING *
      ), event AS (
        INSERT INTO analytics_events (id,schema_version,name,occurred_at,source,platform,actor_id,journey_id,activity_id,plan_id,invite_id,context,synthetic,test)
        SELECT $5,1,'invite_created',now(),'server',$6,i.inviter_id,$7,i.activity_id,i.plan_id,i.id,
          jsonb_build_object('operation','create_invite','rail',i.rail,'inviterRole',i.inviter_role,'generation',i.inviter_generation,
            'inviterRootId',i.inviter_root_id,'expiresAt',${isoTime('i.expires_at')},
            'assignment',(SELECT ${assignmentJson('e')} FROM experiment_assignments e WHERE e.activity_id=i.activity_id)),
          u.synthetic OR t.host_synthetic, u.test OR t.host_test
        FROM invite i JOIN users u ON u.id=i.inviter_id CROSS JOIN target t
      ) SELECT t.state, t.plan_id IS NOT NULL AS planned,
        -- Only the inviter who typed the contact sees it again; events and previews never carry it.
        (SELECT jsonb_strip_nulls(jsonb_build_object('recipientContact',i.recipient_contact)) || jsonb_build_object('id',i.id,'code',i.code,'rail',i.rail,'inviterRole',i.inviter_role,'activityId',i.activity_id,'planId',i.plan_id,
          'createdAt',${isoTime('i.created_at')},'expiresAt',${isoTime('i.expires_at')},
          'availability',jsonb_build_object('capacity',t.capacity,'confirmedCount',t.confirmed_count,'remainingSeats',t.capacity-t.confirmed_count,'version',t.version))
          FROM invite i) AS invite
      FROM classified t`, [randomUUID(), generateCode(), inviter, activityId, randomUUID(), source, journeyId, rail, recipient]);
      if (!outcome) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
      if (outcome.invite) {
        response.status(201).json({ data: outcome.invite, requestId: response.locals.requestId });
        return;
      }
      rejectUnavailableActivity(outcome.state, 'it cannot be shared');
      if (outcome.state === 'full') throw new DomainError(409, 'SOLD_OUT', 'No seats remain to share.');
      if (!outcome.planned) throw new Error(`Activity ${activityId} has no plan; cannot issue an invite`);
      // Otherwise the random code collided with an existing one; retry with a new code.
    }
    throw new Error('Could not allocate a unique invite code');
  });
  return router;
}
