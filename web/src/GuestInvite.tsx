import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ViewDeliveryStatus } from './ViewDeliveryStatus';
import { ViewDelivery, type RenderedInviteOpenEvent } from './view-delivery';
import { api, ApiError, appLink, formatPrice, groupedCode, isInviteCode, journey, message, normalizeInviteCode, parseInvitePreview, type InvitePreview } from './api';

type Load = { status: 'idle' } | { status: 'loading' } | { status: 'invalid' } | { status: 'error'; message: string } | { status: 'ready'; preview: InvitePreview };

export function GuestInvite({ initialCode }: { initialCode: string }) {
  const [delivery] = useState(() => new ViewDelivery());
  const [journeyId] = useState(journey);
  const [code, setCode] = useState(() => normalizeInviteCode(initialCode));
  const [entry, setEntry] = useState(initialCode);
  const [entryError, setEntryError] = useState('');
  const [load, setLoad] = useState<Load>({ status: code ? 'loading' : 'idle' });
  const [attempt, setAttempt] = useState(0);
  const resolve = useCallback((signal: AbortSignal) => {
    setLoad({ status: 'loading' });
    api(`/invites/${encodeURIComponent(code)}`, { signal }).then(data => {
      if (!signal.aborted) setLoad({ status: 'ready', preview: parseInvitePreview(data) });
    }).catch(error => {
      if (signal.aborted) return;
      setLoad(error instanceof ApiError && error.code === 'INVALID_INVITE' ? { status: 'invalid' } : { status: 'error', message: message(error) });
    });
  }, [code]);
  useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    resolve(controller.signal);
    return () => controller.abort();
  }, [code, attempt, resolve]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isInviteCode(entry)) { setEntryError('Codes have 12 letters and numbers, for example ABCD-2345-EFGH.'); return; }
    const next = normalizeInviteCode(entry);
    setEntryError('');
    window.history.pushState(null, '', `/invite/${next}`);
    if (next === code) setAttempt(value => value + 1);
    else setCode(next);
  }
  const ready = load.status === 'ready' ? load.preview : null;
  return <>
    {load.status === 'loading' ? <p role="status">Loading your invitation…</p> : null}
    {load.status === 'error' ? <section aria-live="polite">
      <p role="alert">We could not load this invitation. {load.message}</p>
      <button onClick={() => setAttempt(value => value + 1)}>Try again</button>
    </section> : null}
    {ready ? <RenderedInvite key={`${ready.code}:${ready.state}`} preview={ready} journeyId={journeyId} delivery={delivery} /> : null}
    {!ready ? <section aria-labelledby="code-heading">
      <h2 id="code-heading">{load.status === 'invalid' ? 'Invitation not found' : 'Enter an invitation code'}</h2>
      {load.status === 'invalid' ? <p role="alert">This invitation code is not valid. Check the code and try again.</p> : null}
      <form onSubmit={submit}>
        <label>Invitation code<input value={entry} onChange={event => setEntry(event.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={20} /></label>
        {entryError ? <p role="alert">{entryError}</p> : null}
        <button disabled={load.status === 'loading'}>View invitation</button>
      </form>
    </section> : null}
    <ViewDeliveryStatus delivery={delivery} />
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
    <p className="eyebrow">{inviter.displayName} invited you{inviter.role === 'host' ? ' to their activity' : ''}</p>
    <h2 id="invite-heading">{activity.title}</h2>
    <p className="hint">This is a public link: anyone who has it can view and claim an open seat. It is not a personal vouch, and it does not hold a seat for you.</p>
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
      <p className="hint">If the app does not open, install it, then choose “Enter a code”. The link cannot carry your code through a fresh install. Expires <time dateTime={preview.expiresAt}>{new Date(preview.expiresAt).toLocaleString()}</time>.</p>
    </div> : null}
  </section>;
}
