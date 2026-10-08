import { SeatBooking } from './SeatBooking';
import type { RenderedViewEvent, ViewDelivery } from './view-delivery';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message, parseActivityDetail, type ActivityDetail } from './api';

export function ActivityDetails({ id, actorId, journeyId, close, delivery }: { delivery: ViewDelivery; id: string; actorId: string; journeyId: string; close: () => void }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.focus(); }, []);
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
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
      setDetail(activity);
      if (renewView) setViewVersion(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setError(`Could not refresh activity details. ${message(error)}`);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [id]);
  useEffect(() => {
    void loadDetails(true);
    return () => pending.current?.abort();
  }, [loadDetails, attempt]);
  return <section ref={section} tabIndex={-1} aria-labelledby="detail-heading" aria-busy={loading}>
    <h2 id="detail-heading">Activity details</h2>
    <button onClick={close}>Close details</button>
    {!detail && !error ? <p role="status">Loading activity details…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button disabled={loading} onClick={() => setAttempt(value => value + 1)}>Refresh details</button>
    {detail ? <RenderedActivity refresh={() => void loadDetails(false)} delivery={delivery} key={`${detail.id}:${actorId}:${viewVersion}`} activity={detail} actorId={actorId} journeyId={journeyId} /> : null}
  </section>;
}
function RenderedActivity({ activity, actorId, journeyId, delivery, refresh }: { delivery: ViewDelivery; activity: ActivityDetail; actorId: string; journeyId: string; refresh: () => void }) {
  const [event] = useState<RenderedViewEvent>(() => ({ id: crypto.randomUUID(), schemaVersion: 1, name: 'activity_viewed', source: 'client', platform: 'web',
    occurredAt: new Date().toISOString(), actorId: actorId || undefined, journeyId, activityId: activity.id, planId: activity.planId }));
  useEffect(() => {
    delivery.capture(event, activity.title);
  }, [delivery, event, activity.title]);
  const [exposure] = useState<RenderedViewEvent>(() => ({ ...event, id: crypto.randomUUID(), name: 'experiment_exposed' }));
  useEffect(() => {
    if (activity.assignment) delivery.capture(exposure, `${activity.title} invitation experience`);
  }, [delivery, exposure, activity.assignment, activity.title]);
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
    {activity.assignment ? <section aria-label="Invitation experience">
      <h3>Invitations</h3>
      <p>{activity.assignment.variant === 'treatment' && activity.inviteCreationEnabled === false ? 'New invitations are temporarily unavailable. You can still book a seat.' : activity.assignment.variant === 'treatment' ? 'This activity is assigned to the invitation experience.' : 'This activity supports ordinary booking. New invitations are unavailable.'}</p>
      <p className="hint">Invitations do not reserve seats. Invitation sharing is coming in a later update.</p>
    </section> : null}
    <SeatBooking activity={activity} actorId={actorId} journeyId={journeyId} refresh={refresh} />
    <h3>Confirmed participants</h3>
    {activity.participants.length ? <ul>{activity.participants.map(user => <li key={user.id}>{user.displayName}</li>)}</ul> :
      <p>No confirmed participants yet. Hosting does not consume a seat.</p>}
  </>;
}
