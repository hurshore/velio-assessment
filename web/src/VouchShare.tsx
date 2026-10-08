import { useState, type FormEvent } from 'react';
import { api, groupedCode, inviteLink, message, parseCreatedInvite, type Activity, type CreatedInvite } from './api';

// The created vouch is owned by ActivityDetails so it survives detail refreshes for the same actor.
export function VouchShare({ activity, actorId, journeyId, invite, onCreated }: {
  activity: Activity; actorId: string; journeyId: string; invite: CreatedInvite | null; onCreated: (invite: CreatedInvite) => void;
}) {
  const [recipient, setRecipient] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const full = activity.remainingSeats === 0;
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    setError(''); setStatus('');
    // The server normalizes and validates the contact; this only catches an empty entry.
    if (!recipient.trim()) { setError('Enter the email address or phone number of the person you are vouching for.'); return; }
    setCreating(true);
    try {
      onCreated(parseCreatedInvite(await api(`/activities/${activity.id}/invites`,
        { actorId, body: { rail: 'vouch', recipientContact: recipient.trim(), platform: 'web', journeyId } }), activity, 'vouch'));
    } catch (failure) { setError(message(failure)); }
    finally { setCreating(false); }
  }
  async function copy(link: string) {
    setStatus('');
    try { await navigator.clipboard.writeText(link); setStatus('Vouch link copied.'); }
    catch { setStatus('Copying is unavailable here. Select the link and copy it manually.'); }
  }
  const link = invite ? inviteLink(invite.code) : '';
  return <div aria-label="Vouch for a contact" role="group">
    <h4>Vouch for a contact</h4>
    <p>A vouch says you personally vouch for one person you know. Only the person whose contact matches the one you enter can claim a seat with it; anyone else who opens it sees the activity but cannot claim.</p>
    <p className="hint">Contacts are not verified in this demo: the app compares your entry with the contact saved on the guest's demo identity. Guests never see the contact you enter.</p>
    <p>{activity.remainingSeats} of {activity.capacity} seats remaining right now. A vouch does not reserve a seat; your contact can claim one only while places remain.</p>
    <p>It can be used once and expires after 24 hours or when the activity starts, whichever is first.</p>
    {full ? <p>No seats remain, so there is nothing to vouch for.</p> : null}
    <form onSubmit={event => void create(event)}>
      <label>Contact's email or phone<input value={recipient} onChange={event => setRecipient(event.target.value)} autoComplete="off" maxLength={254} /></label>
      <button disabled={creating || full}>{creating ? 'Creating vouch…' : 'Create vouch'}</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {invite ? <>
      <p>Only {invite.recipientContact} can claim this vouch.</p>
      <label>Vouch link<input readOnly value={link} onFocus={event => event.currentTarget.select()} /></label>
      <p>Code for the app: <strong>{groupedCode(invite.code)}</strong></p>
      <p className="hint">Expires <time dateTime={invite.expiresAt}>{new Date(invite.expiresAt).toLocaleString()}</time>.</p>
      <button onClick={() => void copy(link)}>Copy vouch link</button>
    </> : null}
    <p role="status" className="live">{status}</p>
  </div>;
}
