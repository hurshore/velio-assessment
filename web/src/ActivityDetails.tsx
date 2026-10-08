import { useLiveActivity } from './useLiveActivity';
import { SeatBooking } from './SeatBooking';
import type { RenderedViewEvent, ViewDelivery } from './view-delivery';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message, parseActivityDetail, type ActivityDetail } from './api';

export function ActivityDetails({ id, actorId, journeyId, close, delivery }: { delivery: ViewDelivery; id: string; actorId: string; journeyId: string; close: () => void }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.focus(); }, []);
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const live = useLiveActivity(id, detail, setDetail);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewVersion, setViewVersion] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const loadDetails = useCallback(async (renewView: boolean) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setError('');
    try {
      const data = await api(`/activities/${id}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const activity = parseActivityDetail(data);
      setDetail(previous => !previous || activity.version >= previous.version ? activity : previous);
      if (renewView) setViewVersion(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setError(`Could not refresh activity details. ${message(error)}`);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [id]);
  useEffect(() => {
    void loadDetails(true);
    return () => pending.current?.abort();
  }, [loadDetails, attempt]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') void loadDetails(false); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [loadDetails]);
  return <section ref={section} tabIndex={-1} aria-labelledby="detail-heading" aria-busy={loading}>
    <h2 id="detail-heading">Activity details</h2>
    <button onClick={close}>Close details</button>
    {!detail && !error ? <p role="status">Loading activity details…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <p role="status">{live.status}</p>
    <button disabled={loading} onClick={() => setAttempt(value => value + 1)}>Refresh details</button>
    {detail ? <RenderedActivity stale={live.stale} refresh={() => void loadDetails(false)} delivery={delivery} key={`${detail.id}:${actorId}:${viewVersion}`} activity={detail} actorId={actorId} journeyId={journeyId} /> : null}
  </section>;
}
function RenderedActivity({ activity, actorId, journeyId, delivery, refresh, stale }: { stale: boolean; delivery: ViewDelivery; activity: ActivityDetail; actorId: string; journeyId: string; refresh: () => void }) {
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
    <p className="hint">Availability changes until your booking commits. A displayed seat is not reserved.</p>
    {activity.remainingSeats === 0 ? <p>This activity is full. Confirmed participants are shown below.</p> : null}
    <p className="hint">Shared plan: {activity.planId}</p>
    <SeatBooking stale={stale} activity={activity} actorId={actorId} journeyId={journeyId} refresh={refresh} />
    <h3>Confirmed participants</h3>
    {activity.participants.length ? <ul>{activity.participants.map(user => <li key={user.id}>{user.displayName}</li>)}</ul> :
      <p>No confirmed participants yet. Hosting does not consume a seat.</p>}
  </>;
}
