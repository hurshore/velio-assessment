import { useState } from 'react';
import { api, groupedCode, inviteLink, message, parseCreatedInvite, type Activity, type CreatedInvite } from './api';

// The created invite is owned by ActivityDetails so it survives detail refreshes for the same actor.
export function PublicShare({ activity, actorId, journeyId, invite, onCreated }: {
  activity: Activity; actorId: string; journeyId: string; invite: CreatedInvite | null; onCreated: (invite: CreatedInvite) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const full = activity.remainingSeats === 0;
  async function create() {
    if (creating) return;
    setCreating(true); setError(''); setStatus('');
    try {
      onCreated(parseCreatedInvite(await api(`/activities/${activity.id}/invites`, { actorId, body: { rail: 'public', platform: 'web', journeyId } }), activity, 'public'));
    } catch (failure) { setError(message(failure)); }
    finally { setCreating(false); }
  }
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
    {error ? <p role="alert">{error}</p> : null}
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
