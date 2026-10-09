import { ErrorNotice } from './ErrorNotice';
import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, stored, persist, groupedCode, inviteLink, message, parseCreatedInvite, type Activity, type CreatedInvite } from './api';

interface VouchState {
  // A new session starts on every actor change, so a late response cannot land after switching away and back.
  actorId: string; session: number; draft: string; creating: boolean; error: string; contactInvalid: boolean; status: string; created: CreatedInvite | null;
}
const initial = (actorId: string, session = 0): VouchState => ({ actorId, session, draft: '', creating: false, error: '', contactInvalid: false, status: '', created: null });

// Owned by ActivityDetails, above the view that remounts on refresh, so the draft, an in-flight
// creation and its result survive ordinary detail refreshes. ActivityDetails remounts per activity;
// a different actor restores only their own draft, and previous-session responses are ignored.
export function useVouch(actorId: string, journeyId: string, activityId = '') {
  const storageKey = `velio.vouch.v1:${actorId}:${activityId}`;
  function restore(owner: string, session = 0): VouchState {
    const empty = initial(owner, session);
    try {
      const saved = JSON.parse(stored(`velio.vouch.v1:${owner}:${activityId}`));
      const created = saved.created ? parseCreatedInvite(saved.created, { id: activityId, planId: saved.created.planId }, 'vouch') : null;
      return { ...empty, draft: typeof saved.draft === 'string' ? saved.draft : '', created,
        status: saved.creating ? 'A previous vouch request may have completed. Keep any issued link before creating another.' : '' };
    } catch { return empty; }
  }
  const [state, setState] = useState(() => restore(actorId));
  useEffect(() => {
    if (state.actorId === actorId && !persist(storageKey, JSON.stringify({ draft: state.draft, created: state.created, creating: state.creating }))) {
      setState(previous => previous.status.includes('storage is unavailable') ? previous : { ...previous, status: 'Browser storage is unavailable. Keep this link and contact before reloading.' });
    }
  }, [state.actorId, state.draft, state.created, state.creating, actorId, storageKey]);
  if (state.actorId !== actorId) setState(restore(actorId, state.session + 1));
  const current = state.actorId === actorId ? state : restore(actorId, state.session + 1);
  const update = (session: number, change: (previous: VouchState) => Partial<VouchState>) =>
    setState(previous => previous.session === session ? { ...previous, ...change(previous) } : previous);
  return {
    ...current,
    edit(draft: string) {
      // A shown link belongs to the contact it was created for; editing hides it rather than
      // leaving it beside a different contact. Hiding does not revoke the issued vouch.
      update(current.session, previous => previous.created
        ? { draft, error: '', contactInvalid: false, created: null, status: `The vouch for ${previous.created.recipientContact} was hidden. It is still valid until it expires; create a new vouch for the new contact.` }
        : { draft, error: '', contactInvalid: false });
    },
    // Returns false when the contact needs attention before any request is sent.
    create(activity: Activity): boolean {
      if (current.creating) return true;
      // The server normalizes and validates the contact; this only catches an empty entry.
      if (!current.draft.trim()) {
        update(current.session, () => ({ error: 'Enter the email address or phone number of the person you are vouching for.', contactInvalid: true, status: '' }));
        return false;
      }
      const owner = current.session;
      update(owner, () => ({ creating: true, error: '', contactInvalid: false, status: '' }));
      api(`/activities/${activity.id}/invites`, { actorId, body: { rail: 'vouch', recipientContact: current.draft.trim(), platform: 'web', journeyId } })
        .then(data => {
          const created = parseCreatedInvite(data, activity, 'vouch');
          update(owner, () => ({ creating: false, created, status: `Vouch created for ${created.recipientContact}. Only they can claim it.` }));
        })
        .catch(failure => update(owner, () => ({ creating: false, error: message(failure),
          contactInvalid: failure instanceof ApiError && (failure.code === 'INVALID_REQUEST' || failure.code === 'SELF_INVITE') })));
      return true;
    },
    announce(status: string) { update(current.session, () => ({ status })); },
  };
}
export type Vouch = ReturnType<typeof useVouch>;

export function VouchShare({ activity, vouch }: { activity: Activity; vouch: Vouch }) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const hintId = useId();
  const createdId = useId();
  const full = activity.remainingSeats === 0;
  const created = vouch.created?.planId === activity.planId ? vouch.created : null;
  async function copy(link: string) {
    try { await navigator.clipboard.writeText(link); vouch.announce('Vouch link copied.'); }
    catch { vouch.announce('Copying is unavailable here. Select the link and copy it manually.'); }
  }
  const link = created ? inviteLink(created.code) : '';
  return <div aria-label="Vouch for a contact" role="group">
    <h4>Vouch for a contact</h4>
    <p>A vouch says you personally vouch for one person you know. Only the person whose contact matches the one you enter can claim a seat with it; anyone else who opens it sees the activity but cannot claim.</p>
    <p className="hint">Contacts are not verified in this demo: the app compares your entry with the contact saved on the guest's demo identity. Guests never see the contact you enter.</p>
    <p>{activity.remainingSeats} of {activity.capacity} seats remaining right now. A vouch does not reserve a seat; your contact can claim one only while places remain.</p>
    <p>It can be used once and expires after 24 hours or when the activity starts, whichever is first.</p>
    {full ? <p>No seats remain, so there is nothing to vouch for.</p> : null}
    <form onSubmit={event => { event.preventDefault(); if (!vouch.create(activity)) input.current?.focus(); }}>
      <label>Contact's email or phone<input ref={input} value={vouch.draft} onChange={event => vouch.edit(event.target.value)} autoComplete="off" maxLength={254} readOnly={vouch.creating}
        aria-invalid={vouch.contactInvalid} aria-describedby={vouch.error ? `${hintId} ${errorId}` : hintId} /></label>
      <p className="hint" id={hintId}>Matching ignores letter case, spaces and punctuation but nothing else: use the same format the guest saved, for example the same country code or none.</p>
      <button disabled={vouch.creating || full}>{vouch.creating ? 'Creating vouch…' : 'Create vouch'}</button>
    </form>
    {vouch.error ? <ErrorNotice id={errorId} text={vouch.error} /> : null}
    {created ? <section aria-labelledby={createdId}>
      <h5 id={createdId}>Vouch link for {created.recipientContact}</h5>
      <p>Only {created.recipientContact} can claim this vouch.</p>
      <label>Vouch link<input readOnly value={link} onFocus={event => event.currentTarget.select()} /></label>
      <p>Code for the app: <strong>{groupedCode(created.code)}</strong></p>
      <p className="hint">Expires <time dateTime={created.expiresAt}>{new Date(created.expiresAt).toLocaleString()}</time>.</p>
      <button onClick={() => void copy(link)}>Copy vouch link</button>
    </section> : null}
    <p role="status" className="live">{vouch.status}</p>
  </div>;
}
