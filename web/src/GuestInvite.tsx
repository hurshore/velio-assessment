import { followRoute, navigate } from './navigation';
import { ErrorNotice } from './ErrorNotice';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ViewDeliveryStatus } from './ViewDeliveryStatus';
import { ViewDelivery, type RenderedInviteOpenEvent } from './view-delivery';
import { api, ApiError, appLink, formatPrice, groupedCode, isInviteCode, journey, message, normalizeInviteCode, parseInvitePreview, type InvitePreview } from './api';

type Load = { status: 'idle' } | { status: 'loading' } | { status: 'invalid' } | { status: 'error'; message: string } | { status: 'ready'; preview: InvitePreview };

const headingFor = (load: Load) => load.status === 'ready' ? 'invite-heading' : load.status === 'error' ? 'invite-error' : 'code-heading';

export function GuestInvite({ code: urlCode }: { code: string }) {
  const [delivery] = useState(() => new ViewDelivery());
  const [journeyId] = useState(journey);
  const code = normalizeInviteCode(urlCode);
  const [entry, setEntry] = useState(urlCode);
  const [entryError, setEntryError] = useState('');
  const [shownCode, setShownCode] = useState(urlCode);
  // The URL is the source of truth: Back/Forward replace the entry with the code being shown.
  if (shownCode !== urlCode) { setShownCode(urlCode); setEntry(urlCode); setEntryError(''); }
  const [load, setLoad] = useState<Load>({ status: code ? 'loading' : 'idle' });
  const [attempt, setAttempt] = useState(0);
  const lastRequest = useRef<string | null>(null);
  const focusOnSettle = useRef(false);
  useEffect(() => {
    const request = `${code}:${attempt}`;
    // Only a change after the first load is user navigation; StrictMode re-runs keep the same key.
    if (lastRequest.current !== null && lastRequest.current !== request) focusOnSettle.current = true;
    lastRequest.current = request;
    if (!code) { setLoad({ status: 'idle' }); return; }
    const controller = new AbortController();
    setLoad({ status: 'loading' });
    api(`/invites/${encodeURIComponent(code)}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setLoad({ status: 'ready', preview: parseInvitePreview(data) });
    }).catch(error => {
      if (controller.signal.aborted) return;
      setLoad(error instanceof ApiError && error.code === 'INVALID_INVITE' ? { status: 'invalid' } : { status: 'error', message: message(error) });
    });
    return () => controller.abort();
  }, [code, attempt]);
  useEffect(() => {
    if (!focusOnSettle.current || load.status === 'loading') return;
    focusOnSettle.current = false;
    document.getElementById(headingFor(load))?.focus();
  }, [load]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isInviteCode(entry)) { setEntryError('Codes have 12 letters and numbers, for example ABCD-2345-EFGH.'); return; }
    const next = normalizeInviteCode(entry);
    setEntryError('');
    if (next === code) setAttempt(value => value + 1);
    else navigate(`/invite/${next}`);
  }
  const ready = load.status === 'ready' ? load.preview : null;
  return <>
    <p role="status" className="live">{load.status === 'loading' ? 'Loading your invitation…' : ''}</p>
    {load.status === 'error' ? <section aria-live="polite">
      <div id="invite-error" tabIndex={-1}><ErrorNotice text={`We could not load this invitation. ${load.message}`} /></div>
      <button onClick={() => setAttempt(value => value + 1)}>Try again</button>
    </section> : null}
    {ready ? <RenderedInvite key={`${ready.code}:${ready.state}`} preview={ready} journeyId={journeyId} delivery={delivery} /> : null}
    {!ready ? <section aria-labelledby="code-heading">
      <h2 id="code-heading" tabIndex={-1}>{load.status === 'invalid' ? 'Invitation not found' : 'Enter an invitation code'}</h2>
      {load.status === 'invalid' ? <p role="alert">This invitation code is not valid. Check the code and try again.</p> : null}
      <form onSubmit={submit}>
        <label>Invitation code<input value={entry} onChange={event => setEntry(event.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={20} /></label>
        {entryError ? <p role="alert">{entryError}</p> : null}
        <button disabled={load.status === 'loading'}>View invitation</button>
      </form>
    </section> : null}
<a className="text-link" href="/invite" onClick={event => followRoute(event, "/invite")}>Try another code</a><ViewDeliveryStatus delivery={delivery} />
  </>;
}

const stateCopy: Record<Exclude<InvitePreview['state'], 'valid'>, string> = {
  full: 'The last spot has been taken. This activity is full, so there is no seat to claim.',
  expired: 'This invitation has expired. Ask for a new link if places are still open.',
  started: 'This activity has already started, so new seats cannot be claimed.',
  cancelled: 'This activity was cancelled. No seats can be claimed.',
};

function RenderedInvite({ preview, journeyId, delivery }: { preview: InvitePreview; journeyId: string; delivery: ViewDelivery }) {
  const { activity, inviter } = preview;
  const [event] = useState<RenderedInviteOpenEvent>(() => ({ id: crypto.randomUUID(), schemaVersion: 1, name: 'invite_opened', source: 'client', platform: 'web',
    occurredAt: new Date().toISOString(), journeyId, inviteCode: preview.code, displayedState: preview.state }));
  useEffect(() => { delivery.capture(event, `${activity.title} invitation`); }, [delivery, event, activity.title]);
  const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: activity.timezone }).format(new Date(activity.startsAt));
  return <section aria-labelledby="invite-heading" className="guest-invite">
    <p className="eyebrow">{inviter.displayName} {preview.rail === 'vouch' ? 'vouched for you' : 'invited you'}{inviter.role === 'host' ? ' to their activity' : ''}</p>
    <h2 id="invite-heading" tabIndex={-1}>{activity.title}</h2>
    {preview.rail === 'vouch' ? <>
      <p className="hint">This is a personal vouch for one specific contact. Only that person can claim a seat with it: the app matches it to the contact saved on your demo identity. It does not hold a seat for you.</p>
      <p className="hint">Contacts are not verified in this demo, so matching simulates a trusted introduction rather than proving who you are.</p>
    </> : <p className="hint">This is a public link: anyone who has it can view and claim an open seat. It is not a personal vouch, and it does not hold a seat for you.</p>}
    {preview.state !== 'valid' ? <p role="alert">{stateCopy[preview.state]}</p> : null}
    <p className="description">{activity.description}</p>
    <dl>
      <dt>When</dt><dd>{time} ({activity.timezone})</dd>
      <dt>Where</dt><dd>{activity.meetingLocation}</dd>
      <dt>Price</dt><dd>{formatPrice(activity.priceMinor, activity.currency)} · no payment is taken in this demo</dd>
      <dt>Availability</dt><dd>{activity.remainingSeats} of {activity.capacity} seats open right now</dd>
    </dl>
    {preview.state === 'valid' ? <div className="app-handoff">
      <h3>Claim your seat in the app</h3>
      <p>Seats are confirmed only when you claim one in the Velio app. Open the app directly, or enter this code there:</p>
      <p className="invite-code">{groupedCode(preview.code)}</p>
      <a className="button-link" href={appLink(preview.code, journeyId)}>Open in the Velio app</a>
      <p className="hint">If the app does not open, install it, then enter the code above. The link cannot carry your code through a fresh install. Expires <time dateTime={preview.expiresAt}>{new Date(preview.expiresAt).toLocaleString()}</time>.</p>
    </div> : <div className="app-handoff"><h3>Already have a booking?</h3><p>Open the app with your original demo identity to recover your confirmation.</p><p className="invite-code">{groupedCode(preview.code)}</p><a className="button-link" href={appLink(preview.code, journeyId)}>Recover booking in the app</a></div>}
  </section>;
}
