import { useState } from 'react';
import { api, groupedCode, inviteLink, message, parseCreatedInvite, type Activity, type CreatedInvite } from './api';

export function PublicShare({ activity, actorId, journeyId }: { activity: Activity; actorId: string; journeyId: string }) {
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const full = activity.remainingSeats === 0;
  async function create() {
    if (creating) return;
    setCreating(true); setError(''); setStatus('');
    try {
      setInvite(parseCreatedInvite(await api(`/activities/${activity.id}/invites`, { actorId, body: { rail: 'public', platform: 'web', journeyId } }), activity.id));
    } catch (error) { setError(message(error)); }
    finally { setCreating(false); }
  }
  async function copy(link: string) {
    try { await navigator.clipboard.writeText(link); setStatus('Link copied.'); }
    catch { setStatus('Copying is unavailable here. Select the link and copy it manually.'); }
  }
  async function share(link: string) {
    try { await navigator.share({ title: activity.title, text: `Join me at ${activity.title}. Seats are not reserved; claim one while places remain.`, url: link }); }
    catch (error) {
      // Dismissing the share sheet is a normal choice, not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('Sharing is unavailable here. Copy the link instead.');
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
      {status ? <p role="status">{status}</p> : null}
    </> : null}
  </div>;
}
