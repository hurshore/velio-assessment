import { ErrorNotice } from './ErrorNotice';
import { useEffect, useState } from 'react';
import { api, persist, stored, groupedCode, inviteLink, message, parseCreatedInvite, type Activity, type CreatedInvite } from './api';

interface PublicState {
  actorId: string; session: number; creating: boolean; error: string; warning: string; invite: CreatedInvite | null;
}
function restored(actorId: string, activityId: string, session = 0): PublicState {
  const empty: PublicState = { actorId, session, creating: false, error: '', warning: '', invite: null };
  try {
    const saved = JSON.parse(stored(`velio.public.v1:${actorId}:${activityId}`));
    return { ...empty, invite: saved.invite ? parseCreatedInvite(saved.invite, { id: activityId, planId: saved.invite.planId }, 'public') : null,
      warning: saved.creating ? 'A previous link request may have completed. Keep any issued link before creating another.' : '' };
  } catch { return empty; }
}
// Keep pending creation above the detail view that remounts when a fresh view is recorded.
export function usePublicShare(actorId: string, journeyId: string, activityId: string) {
  const [state, setState] = useState(() => restored(actorId, activityId));
  if (state.actorId !== actorId) setState(restored(actorId, activityId, state.session + 1));
  const current = state.actorId === actorId ? state : restored(actorId, activityId, state.session + 1);
  useEffect(() => {
    if (state.actorId === actorId && !persist(`velio.public.v1:${actorId}:${activityId}`, JSON.stringify({ invite: state.invite, creating: state.creating }))) {
      setState(previous => previous.warning.includes('storage is unavailable') ? previous : { ...previous, warning: 'Browser storage is unavailable. Keep your link before reloading.' });
    }
  }, [actorId, activityId, state.actorId, state.invite, state.creating]);
  return { ...current, async create(activity: Activity) {
    if (current.creating) return;
    const owner = current.session;
    const update = (change: Partial<PublicState>) => setState(previous => previous.session === owner ? { ...previous, ...change } : previous);
    update({ creating: true, error: '', warning: '' });
    try {
      const invite = parseCreatedInvite(await api(`/activities/${activity.id}/invites`, { actorId, body: { rail: 'public', platform: 'web', journeyId } }), activity, 'public');
      update({ invite });
    } catch (failure) { update({ error: message(failure) }); }
    finally { update({ creating: false }); }
  } };
}
export type PublicSharing = ReturnType<typeof usePublicShare>;
export function PublicShare({ activity, sharing }: { activity: Activity; sharing: PublicSharing }) {
  const { creating, error, warning } = sharing;
  const invite = sharing.invite?.planId === activity.planId ? sharing.invite : null;
  const [status, setStatus] = useState('');
  const full = activity.remainingSeats === 0;
  async function create() { setStatus(''); await sharing.create(activity); }
  async function copy(link: string) {
    setStatus('');
    try { await navigator.clipboard.writeText(link); setStatus('Link copied.'); }
    catch { setStatus('Copying is unavailable here. Select the link and copy it manually.'); }
  }
  async function share(link: string) {
    setStatus('');
    try { await navigator.share({ title: activity.title, text: `Join me at ${activity.title}. Seats are not reserved; claim one while places remain.`, url: link }); }
    catch (failure) {
      // Dismissing the share sheet is a normal choice, not a failure.
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) setStatus('Sharing is unavailable here. Copy the link instead.');
    }
  }
  const link = invite ? inviteLink(invite.code) : '';
  return <div aria-label="Public share link" role="group">
    <h4>Public share link</h4>
    <p>Anyone with this link can see this activity and claim an open seat while places remain. It is not a personal vouch, and it does not reserve a seat for anyone.</p>
    <p>{activity.remainingSeats} of {activity.capacity} seats remaining right now. Links expire after 24 hours or when the activity starts, whichever is first.</p>
    {full ? <p>No seats remain, so there is nothing to share.</p> : null}
    <button disabled={creating || full} onClick={() => void create()}>{creating ? 'Creating link…' : 'Create public link'}</button>
    {error ? <ErrorNotice text={error} /> : null}
    {warning ? <p role="status">{warning}</p> : null}
    {invite ? <>
      <label>Share link<input readOnly value={link} onFocus={event => event.currentTarget.select()} /></label>
      <p>Code for the app: <strong>{groupedCode(invite.code)}</strong></p>
      <p className="hint">Expires <time dateTime={invite.expiresAt}>{new Date(invite.expiresAt).toLocaleString()}</time>.</p>
      <div className="button-row">
        <button onClick={() => void copy(link)}>Copy link</button>
        {'share' in navigator ? <button onClick={() => void share(link)}>Share link</button> : null}
      </div>
    </> : null}
    <p role="status" className="live">{status}</p>
  </div>;
}
