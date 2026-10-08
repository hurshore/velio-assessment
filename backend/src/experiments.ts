import { Router } from 'express';
import { DomainError, rows, uuid, type Database } from './domain.js';

export type Variant = 'treatment' | 'control';
export type PolicyReason = 'allowed' | 'creation_disabled' | 'control' | 'host_or_booker_required' | 'assignment_unavailable';
export interface Assignment {
  experiment: 'group_invites_v1'; version: string; treatmentPercent: number; variant: Variant; assignedAt: string;
}
export interface InviteConfig { readonly version: string; readonly treatmentPercent: number; readonly creationEnabled: boolean }
export function loadInviteConfig(env: Record<string, string | undefined>): InviteConfig {
  const version = (env.INVITE_EXPERIMENT_VERSION ?? '1').trim();
  const percent = env.INVITE_TREATMENT_PERCENT ?? '50';
  const enabled = env.INVITE_CREATION_ENABLED ?? 'true';
  if (!version || version.length > 100) throw new Error('INVITE_EXPERIMENT_VERSION must contain 1–100 characters.');
  if (!/^\d+$/.test(percent) || Number(percent) > 100) throw new Error('INVITE_TREATMENT_PERCENT must be an integer from 0 to 100.');
  if (enabled !== 'true' && enabled !== 'false') throw new Error('INVITE_CREATION_ENABLED must be true or false.');
  return { version, treatmentPercent: Number(percent), creationEnabled: enabled === 'true' };
}
// The alias must identify an experiment_assignments table in the caller's query.
// LEFT JOINs represent damaged/missing assignment data as null, never a fabricated cohort.
export function assignmentJson(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Assignment SQL alias must be a simple identifier.');
  return `CASE WHEN ${alias}.activity_id IS NULL THEN NULL ELSE jsonb_build_object('experiment',${alias}.experiment,'version',${alias}.version,
    'treatmentPercent',${alias}.treatment_percent,'variant',${alias}.variant,'assignedAt',${alias}.assigned_at) END`;
}
export interface InviteState { creationEnabled: boolean; allowed: boolean; reason: PolicyReason }
export interface InvitePolicyResult extends InviteState { assignment: Assignment | null }
function policyReason(assignment: Assignment | null, enabled: boolean, eligible: boolean): PolicyReason {
  if (!assignment) return 'assignment_unavailable';
  if (!enabled) return 'creation_disabled';
  if (assignment.variant === 'control') return 'control';
  if (!eligible) return 'host_or_booker_required';
  return 'allowed';
}
export function createInvitePolicy(db: Database, config: InviteConfig) {
  const creationEnabled = config.creationEnabled;
  async function evaluate(activityId: string, actorId?: string): Promise<InvitePolicyResult> {
    if (actorId) {
      uuid(actorId, 'Identity');
      const [actor] = await rows(db, 'SELECT id FROM users WHERE id=$1', [actorId]);
      if (!actor) throw new DomainError(401, 'IDENTITY_REQUIRED', 'Selected demo identity was not found.');
    }
    const [state] = await rows<{ assignment: Assignment | null; eligible: boolean }>(db, `SELECT ${assignmentJson('assignment')} AS assignment,
      ($2::uuid IS NOT NULL AND (a.host_id=$2 OR EXISTS (SELECT 1 FROM bookings b WHERE b.activity_id=a.id AND b.user_id=$2))) AS eligible
      FROM activities a LEFT JOIN experiment_assignments assignment ON assignment.activity_id=a.id WHERE a.id=$1`, [activityId, actorId ?? null]);
    if (!state) throw new DomainError(404, 'NOT_FOUND', 'Activity was not found.');
    const reason = policyReason(state.assignment, creationEnabled, state.eligible);
    return { assignment: state.assignment, creationEnabled, allowed: reason === 'allowed', reason };
  }
  // Invitation creation handlers must use this bound policy at their write boundary.
  // Resolution and claims of issued invites are independent of this creation-only policy.
  async function requireCreation(activityId: string, actorId: string) {
    const policy = await evaluate(activityId, actorId);
    if (!policy.allowed) throw new DomainError(403, 'INVITE_CREATION_UNAVAILABLE', 'New invitations are unavailable for this activity or identity.');
    return policy;
  }
  return { evaluate, requireCreation };
}
export type InvitePolicy = ReturnType<typeof createInvitePolicy>;
export function experimentRoutes(policy: InvitePolicy) {
  const router = Router();
  router.get('/:id/invite-eligibility', async (request, response) => {
    response.json({ data: await policy.evaluate(uuid(request.params.id, 'Activity'), request.get('X-Demo-Actor-Id')), requestId: response.locals.requestId });
  });
  return router;
}
