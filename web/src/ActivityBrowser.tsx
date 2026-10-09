import { ErrorNotice } from './ErrorNotice';
import { navigate, usePath, followRoute } from './navigation';
import { displayTime, activityStatus, priceToMinor } from './presentation';
import { formatPrice } from './api';
import type { ViewDelivery } from './view-delivery';
import { ActivityDetails } from './ActivityDetails';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, message, parseActivity, parseList, type Activity } from './api';

const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function defaultStart(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T09:00`;
}
function localInstant(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error('Choose a valid start date and time.');
  const parts = value.split(/[-T:]/).map(Number);
  if (date.getFullYear() !== parts[0] || date.getMonth() + 1 !== parts[1] || date.getDate() !== parts[2] ||
    date.getHours() !== parts[3] || date.getMinutes() !== parts[4]) throw new Error('This local time does not exist in your device timezone. Choose another time.');
  return date.toISOString();
}
export function ActivityBrowser({ actorId, journeyId, setHosting, delivery, requestIdentity }: { requestIdentity?: () => void; delivery: ViewDelivery; actorId: string; journeyId: string; setHosting: (value: boolean) => void }) {
  const path = usePath();
  const selected = path === '/activities/new' ? '' : /^\/activities\/([^/]+)\/?$/.exec(path)?.[1] ?? '';
  const creating = path === '/activities/new';
  const hosting = path === '/hosting';
  const createHeading = useRef<HTMLHeadingElement>(null);
  const browseHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { (creating ? createHeading : browseHeading).current?.focus(); }, [path, creating]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [formError, setFormError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<{ title: string } | null>(null);
  const [starts, setStarts] = useState(defaultStart);
  const [draftActor, setDraftActor] = useState(actorId);
  const [timezone, setTimezone] = useState(deviceTimezone);
  if (draftActor !== actorId) { setDraftActor(actorId); setStarts(defaultStart()); setTimezone(deviceTimezone); setFormError(''); }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setListError('');
    void api('/activities', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setActivities(parseList(data, parseActivity));
    }).catch(error => { if (!controller.signal.aborted) setListError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  let preview = 'Choose a start time to preview it.';
  if (starts) {
    try { preview = `${displayTime(localInstant(starts), timezone)} (${timezone})`; }
    catch (error) { preview = message(error); }
  }
  async function createActivity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setFormError('');
    try {
      if (!actorId) throw new Error('Select a demo identity before hosting.');
      const title = String(data.get('title') ?? '').trim();
      const description = String(data.get('description') ?? '').trim();
      const meetingLocation = String(data.get('meetingLocation') ?? '').trim();
      const capacity = Number(data.get('capacity'));
      const priceMinor = priceToMinor(String(data.get('price') ?? ''), String(data.get('currency') ?? ''));
      const currency = String(data.get('currency') ?? '').trim();
      if (!title || title.length > 120 || !description || description.length > 2000 || !meetingLocation || meetingLocation.length > 300) throw new Error('Enter a title, description and meeting location within the field limits.');
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2147483647) throw new Error('Capacity must be a positive integer.');
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Enter an uppercase three-letter currency code.');
      if ((timezone !== 'UTC' && !timezone.includes('/')) || timezone.startsWith('posix/') || timezone.startsWith('right/')) throw new Error('Choose an IANA display timezone.');
      const startsAt = localInstant(starts);
      displayTime(startsAt, timezone);
      setPending({ title }); setHosting(true);
      const activity = parseActivity(await api('/activities', { actorId, body: { title, description, meetingLocation, startsAt, timezone, capacity, priceMinor, currency } }));
      setActivities(previous => [activity, ...previous.filter(item => item.id !== activity.id)]);
      navigate(`/activities/${activity.id}`);
      form.reset(); setStarts(defaultStart());
    } catch (error) { setFormError(message(error)); }
    finally { setPending(null); setHosting(false); }
  }
  const now = Date.now();
  const isBookable = (activity: Activity) => activity.status === 'scheduled' &&
    activity.remainingSeats > 0 && Date.parse(activity.startsAt) > now;
  const visibleActivities = activities
    .filter(activity => !hosting || (actorId && activity.hostId === actorId))
    .sort((a, b) => Number(isBookable(b)) - Number(isBookable(a)) || Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return <>
    <div hidden={!creating}>
    <button className="secondary" onClick={() => navigate('/hosting')}>← Back to hosting</button>
    <section aria-labelledby="create-heading">
      <p className="eyebrow">MAKE SOMETHING HAPPEN</p><h1 ref={createHeading} tabIndex={-1} id="create-heading">Host an activity</h1>
      <p>Hosting uses no seat. Prices are shown for context; this demo does not take payments.</p>
      {!actorId ? <button onClick={requestIdentity}>Choose a demo identity to host</button> : null}
      <form key={actorId} onSubmit={createActivity}>
        <fieldset disabled={!actorId || loading || pending !== null}>
          <h2>About your plan</h2>
          <label>Title<input name="title" required maxLength={120} /></label>
          <label>Description<textarea name="description" required maxLength={2000} rows={3} /></label>
          <h2>When and where</h2>
          <label>Meeting location<input name="meetingLocation" required maxLength={300} /></label>
          <label>Start date and time (device timezone)<input name="starts" type="datetime-local" required value={starts} onInput={event => setStarts(event.currentTarget.value)} onChange={event => setStarts(event.target.value)} /></label>
          <p className="hint">Entered in {deviceTimezone}. The display timezone changes the preview of that same instant.</p>
          <label>Display timezone (IANA)<input name="timezone" required maxLength={100} value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Africa/Lagos" /></label>
          <p role="status">{preview}</p>
          <h2>Spots and price</h2>
          <div className="form-row">
            <label>Capacity<input name="capacity" type="number" min={1} max={2147483647} step={1} required defaultValue="2" /></label>
            <label>Price per person<input name="price" inputMode="decimal" placeholder="0.00" required defaultValue="0" /></label>
            <label>Currency<input name="currency" required minLength={3} maxLength={3} pattern="[A-Z]{3}" defaultValue="NGN" /></label>
          </div>
          <p className="hint">Enter the amount in normal currency units, for example 15.00 NGN. Use 0 for free.</p>
          <button>{pending ? 'Saving activity…' : 'Create activity'}</button>
        </fieldset>
      </form>
      {formError ? <ErrorNotice text={`${formError} Your entry was removed from the pending list; your form is preserved. If the connection failed after saving, refresh activities before retrying.`} /> : null}
    </section>
    </div>
    <div hidden={creating || Boolean(selected)}>
    <div className="page-intro"><div><p className="eyebrow">GOOD COMPANY STARTS HERE</p><h1 ref={browseHeading} tabIndex={-1}>{hosting ? 'Your plans, brought to life.' : <>Make time for <span>good company.</span></>}</h1><p>{hosting ? 'Create a plan. See who’s joining. Bring someone along.' : 'Find something worth showing up for. Take a spot and make it a plan.'}</p></div><a className="button-link" href="/activities/new" onClick={event => followRoute(event, '/activities/new')}>＋ Host an activity</a></div>
    <section className="discovery" aria-labelledby="browse-heading" aria-busy={loading}>
      <div className="section-heading"><h2 id="browse-heading">{hosting ? 'Activities you host' : 'Explore activities'}</h2>
      <button disabled={loading || pending !== null} onClick={() => setAttempt(value => value + 1)}>Refresh activities</button></div>
      {loading ? <p role="status">Loading activities…</p> : null}
      {listError ? <ErrorNotice text={listError} /> : null}
      {!loading && !listError && !activities.length && !pending ? <p>No activities yet. Be the first to host one.</p> : null}
      <ul className="activities">
        {pending ? <li role="status">{pending.title} — Saving…</li> : null}
        {visibleActivities.map((activity, index) => <li key={activity.id}>
          <a className="activity-card" href={`/activities/${activity.id}`} onClick={event => followRoute(event, `/activities/${activity.id}`)}>
          <div className={`activity-art art-${index % 3}`} aria-hidden="true"><span>✳</span></div>
          <div className="card-content"><span className="badge">{activityStatus(activity)}</span><h3>{activity.title}</h3><p>{activity.meetingLocation}</p><p className="hint">{displayTime(activity.startsAt, activity.timezone)}</p><div className="card-footer"><strong>{formatPrice(activity.priceMinor, activity.currency)}</strong><span>View activity ↗</span></div></div></a>
        </li>)}
      </ul>
    </section>
    {hosting && !actorId ? <button onClick={requestIdentity}>Choose a demo identity to see your hosting</button> : null}
    {hosting && actorId && !loading && !activities.some(activity => activity.hostId === actorId) ? <p>You haven’t hosted an activity yet. Start with something you’d enjoy.</p> : null}
    </div>
    {selected ? <ActivityDetails delivery={delivery} key={selected} id={selected} actorId={actorId} journeyId={journeyId} requestIdentity={requestIdentity} close={() => navigate(window.history.state?.returnTo === '/hosting' ? '/hosting' : '/')} /> : null}
  </>;
}
