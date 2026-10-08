import type { RenderedViewEvent, ViewDelivery } from './view-delivery';
import { useEffect, useRef, useState } from 'react';
import { api, message, parseActivity, type Activity } from './api';

export function ActivityDetails({ id, actorId, journeyId, close, delivery }: { delivery: ViewDelivery; id: string; actorId: string; journeyId: string; close: () => void }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.focus(); }, []);
  const [detail, setDetail] = useState<Activity | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError('');
    void api(`/activities/${id}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      const activity = parseActivity(data);
      if (!activity.participants) throw new Error('The API returned invalid participants.');
      setDetail(activity);
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [id, attempt]);
  return <section ref={section} tabIndex={-1} aria-labelledby="detail-heading" aria-busy={!detail && !error}>
    <h2 id="detail-heading">Activity details</h2>
    <button onClick={close}>Close details</button>
    {!detail && !error ? <p role="status">Loading activity details…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button disabled={!detail && !error} onClick={() => setAttempt(value => value + 1)}>Refresh details</button>
    {detail ? <RenderedActivity delivery={delivery} key={`${detail.id}:${actorId}`} activity={detail} actorId={actorId} journeyId={journeyId} /> : null}
  </section>;
}
function RenderedActivity({ activity, actorId, journeyId, delivery }: { delivery: ViewDelivery; activity: Activity; actorId: string; journeyId: string }) {
  const [event] = useState<RenderedViewEvent>(() => ({ id: crypto.randomUUID(), schemaVersion: 1, name: 'activity_viewed', source: 'client', platform: 'web',
    occurredAt: new Date().toISOString(), actorId: actorId || undefined, journeyId, activityId: activity.id, planId: activity.planId }));
  useEffect(() => {
    delivery.capture(event, activity.title);
  }, [delivery, event, activity.title]);
  const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: activity.timezone }).format(new Date(activity.startsAt));
  return <>
    <h3>{activity.title}</h3>
    <p className="description">{activity.description}</p>
    <dl>
      <dt>Meeting location</dt><dd>{activity.meetingLocation}</dd>
      <dt>Starts</dt><dd>{time} ({activity.timezone})</dd>
      <dt>Absolute start</dt><dd><time dateTime={activity.startsAt}>{activity.startsAt}</time></dd>
      <dt>Price</dt><dd>{activity.priceMinor} {activity.currency} minor units{activity.priceMinor === 0 ? ' · Free' : ''}</dd>
      <dt>Availability</dt><dd>{activity.remainingSeats} of {activity.capacity} seats remaining · {activity.confirmedCount} confirmed</dd>
      <dt>Status</dt><dd>{activity.status}</dd>
    </dl>
    <p className="hint">Availability is a server snapshot. Refresh details for the latest counts.</p>
    <p className="hint">Shared plan: {activity.planId}</p>
    <h3>Confirmed participants</h3>
    {activity.participants!.length ? <ul>{activity.participants!.map(user => <li key={user.id}>{user.displayName}</li>)}</ul> :
      <p>No confirmed participants yet. Hosting does not consume a seat.</p>}
  </>;
}
