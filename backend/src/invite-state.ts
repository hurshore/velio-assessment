import { DomainError } from './domain.js';

export const previewStates = ['valid', 'full', 'expired', 'started', 'cancelled'] as const;
export type PreviewState = typeof previewStates[number];

// Classifies an invite (alias i) and its activity (alias a) at one observation time, so status,
// start and expiry can never be judged against different clocks. Precedence follows what a guest
// can act on: cancellation, then start (completed counts as started), then expiry, then capacity.
export function inviteStateSql(observedAt: string): string {
  return `CASE WHEN a.status='cancelled' THEN 'cancelled'
    WHEN a.status<>'scheduled' OR a.starts_at <= ${observedAt} THEN 'started'
    WHEN i.expires_at <= ${observedAt} THEN 'expired'
    WHEN a.confirmed_count >= a.capacity THEN 'full' ELSE 'valid' END`;
}

// The activity-level reasons a new seat or invite is impossible, shared by creation, signup and claims.
export function rejectUnavailableActivity(state: PreviewState, action: string): void {
  if (state === 'cancelled') throw new DomainError(409, 'ACTIVITY_UNAVAILABLE', `This activity was cancelled, so ${action}.`);
  if (state === 'started') throw new DomainError(409, 'ACTIVITY_STARTED', `This activity has already started, so ${action}.`);
}

// Never names the intended contact: the claimant learns only that their identity does not match it.
export function rejectRecipient(action: string): never {
  throw new DomainError(403, 'RECIPIENT_MISMATCH', `This vouch was created for a specific contact, and the selected identity's contact does not match it, so ${action}.`);
}
