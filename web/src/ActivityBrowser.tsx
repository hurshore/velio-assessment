import { ActivityDetails } from './ActivityDetails';
import { useEffect, useState, type FormEvent } from 'react';
import { api, message, parseActivity, parseList, type Activity } from './api';

const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function localInstant(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error('Choose a valid start date and time.');
  const parts = value.split(/[-T:]/).map(Number);
  if (date.getFullYear() !== parts[0] || date.getMonth() + 1 !== parts[1] || date.getDate() !== parts[2] ||
    date.getHours() !== parts[3] || date.getMinutes() !== parts[4]) throw new Error('This local time does not exist in your device timezone. Choose another time.');
  return date.toISOString();
}
function displayTime(startsAt: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(new Date(startsAt));
}
export function ActivityBrowser({ actorId, journeyId, setHosting }: { actorId: string; journeyId: string; setHosting: (value: boolean) => void }) {
  const [selected, setSelected] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [formError, setFormError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<{ title: string } | null>(null);
  const [starts, setStarts] = useState('');
  const [timezone, setTimezone] = useState(deviceTimezone);
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
    try { preview = `${displayTime(localInstant(starts), timezone)} (${timezone}) · ${localInstant(starts)}`; }
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
      const priceMinor = Number(data.get('priceMinor'));
      const currency = String(data.get('currency') ?? '').trim();
      if (!title || title.length > 120 || !description || description.length > 2000 || !meetingLocation || meetingLocation.length > 300) throw new Error('Enter a title, description and meeting location within the field limits.');
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2147483647) throw new Error('Capacity must be a positive integer.');
      if (data.get('priceMinor') === '' || !Number.isInteger(priceMinor) || priceMinor < 0 || priceMinor > 2147483647) throw new Error('Price must be a non-negative integer in minor units.');
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Enter an uppercase three-letter currency code.');
      if ((timezone !== 'UTC' && !timezone.includes('/')) || timezone.startsWith('posix/') || timezone.startsWith('right/')) throw new Error('Choose an IANA display timezone.');
      const startsAt = localInstant(starts);
      displayTime(startsAt, timezone);
      setPending({ title }); setHosting(true);
      const activity = parseActivity(await api('/activities', { actorId, body: { title, description, meetingLocation, startsAt, timezone, capacity, priceMinor, currency } }));
      setActivities(previous => [activity, ...previous.filter(item => item.id !== activity.id)]);
      setSelected(activity.id);
      form.reset(); setStarts('');
    } catch (error) { setFormError(message(error)); }
    finally { setPending(null); setHosting(false); }
  }
  return <>
    <section aria-labelledby="create-heading">
      <h2 id="create-heading">Host an activity</h2>
      <p>Hosting uses no seat. Prices are shown for context; this demo does not take payments.</p>
      {!actorId ? <p>Select or create a demo identity to host.</p> : null}
      <form onSubmit={createActivity}>
        <fieldset disabled={!actorId || loading || pending !== null}>
          <label>Title<input name="title" required maxLength={120} /></label>
          <label>Description<textarea name="description" required maxLength={2000} rows={3} /></label>
          <label>Meeting location<input name="meetingLocation" required maxLength={300} /></label>
          <label>Start date and time (device timezone)<input name="starts" type="datetime-local" required value={starts} onChange={event => setStarts(event.target.value)} /></label>
          <p className="hint">Entered in {deviceTimezone}. The display timezone changes the preview of that same instant.</p>
          <label>Display timezone (IANA)<input name="timezone" required maxLength={100} value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Africa/Lagos" /></label>
          <p role="status">{preview}</p>
          <div className="form-row">
            <label>Capacity<input name="capacity" type="number" min={1} max={2147483647} step={1} required /></label>
            <label>Price (minor units)<input name="priceMinor" type="number" min={0} max={2147483647} step={1} required /></label>
            <label>Currency<input name="currency" required minLength={3} maxLength={3} pattern="[A-Z]{3}" placeholder="NGN" /></label>
          </div>
          <p className="hint">For NGN, 1500 minor units means ₦15.00. Use 0 for free.</p>
          <button>{pending ? 'Saving activity…' : 'Create activity'}</button>
        </fieldset>
      </form>
      {formError ? <p role="alert">{formError} Your entry was removed from the pending list; your form is preserved. If the connection failed after saving, refresh activities before retrying.</p> : null}
    </section>
    <section aria-labelledby="browse-heading" aria-busy={loading}>
      <h2 id="browse-heading">Explore activities</h2>
      <button disabled={loading || pending !== null} onClick={() => setAttempt(value => value + 1)}>Refresh activities</button>
      {loading ? <p role="status">Loading activities…</p> : null}
      {listError ? <p role="alert">{listError}</p> : null}
      {!loading && !listError && !activities.length && !pending ? <p>No activities yet. Be the first to host one.</p> : null}
      <ul className="activities">
        {pending ? <li role="status">{pending.title} — Saving…</li> : null}
        {activities.map(activity => <li key={activity.id}><h3>{activity.title}</h3><p>{displayTime(activity.startsAt, activity.timezone)} ({activity.timezone})</p>
          <p>{activity.remainingSeats} of {activity.capacity} seats remaining · {activity.priceMinor} {activity.currency} minor units</p>
          <button onClick={() => setSelected(activity.id)}>View {activity.title}</button>
        </li>)}
      </ul>
    </section>
    {selected ? <ActivityDetails key={selected} id={selected} actorId={actorId} journeyId={journeyId} close={() => setSelected('')} /> : null}
  </>;
}
