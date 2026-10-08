import { Router } from 'express';
import { DomainError, rows, uuid, type Database } from './domain.js';

export interface InviteConfig { version: string; treatmentPercent: number; creationEnabled: boolean }
export const defaultInviteConfig: Readonly<InviteConfig> = { version: '1', treatmentPercent: 50, creationEnabled: true };
export function loadInviteConfig(env: Record<string, string | undefined>): InviteConfig {
  const version = (env.INVITE_EXPERIMENT_VERSION ?? '1').trim();
  const percent = env.INVITE_TREATMENT_PERCENT ?? '50';
  const enabled = env.INVITE_CREATION_ENABLED ?? 'true';
  if (!version || version.length > 100) throw new Error('INVITE_EXPERIMENT_VERSION must contain 1–100 characters.');
  if (!/^\d+$/.test(percent) || Number(percent) > 100) throw new Error('INVITE_TREATMENT_PERCENT must be an integer from 0 to 100.');
  if (enabled !== 'true' && enabled !== 'false') throw new Error('INVITE_CREATION_ENABLED must be true or false.');
  return { version, treatmentPercent: Number(percent), creationEnabled: enabled === 'true' };
}
export const assignmentColumns = `jsonb_build_object('experiment',e.experiment,'version',e.version,
  'treatmentPercent',e.treatment_percent,'variant',e.variant,'assignedAt',e.assigned_at)`;

// Future public/vouch creation handlers must call this policy at the write boundary.
// Resolution and claims deliberately do not depend on a creation switch.
export async function inviteCreationPolicy(db: Database, activityId: string, actorId: string | undefined, creationEnabled: boolean) {
  const [state] = await rows<{ assignment: { variant: string }; eligible: boolean }>(db, `SELECT ${assignmentColumns} AS assignment,
    ($2::uuid IS NOT NULL AND (a.host_id=$2 OR EXISTS (SELECT 1 FROM bookings b WHERE b.activity_id=a.id AND b.user_id=$2))) AS eligible
    FROM activities a JOIN experiment_assignments e ON e.activity_id=a.id WHERE a.id=$1`, [activityId, actorId ?? null]);
  if (!state) throw new DomainError(404, 'NOT_FOUND', 'Activity assignment was not found.');
  const reason = !creationEnabled ? 'creation_disabled' : state.assignment.variant !== 'treatment' ? 'control' : !state.eligible ? 'host_or_booker_required' : 'allowed';
  return { assignment: state.assignment, creationEnabled, allowed: reason === 'allowed', reason };
}
export async function requireInviteCreation(db: Database, activityId: string, actorId: string, creationEnabled: boolean) {
  const policy = await inviteCreationPolicy(db, activityId, actorId, creationEnabled);
  if (!policy.allowed) throw new DomainError(403, 'INVITE_CREATION_UNAVAILABLE', 'New invitations are unavailable for this activity or identity.');
  return policy;
}
export function experimentRoutes(db: Database, config: InviteConfig) {
  const router = Router();
  router.get('/:id/invite-eligibility', async (request, response) => {
    const actor = request.get('X-Demo-Actor-Id');
    const policy = await inviteCreationPolicy(db, uuid(request.params.id, 'Activity'), actor ? uuid(actor, 'Identity') : undefined, config.creationEnabled);
    response.json({ data: policy, requestId: response.locals.requestId });
  });
  return router;
}
