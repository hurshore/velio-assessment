import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLiveActivity } from './useLiveActivity';
import { SeatBooking } from './SeatBooking';
import { PublicShare } from './PublicShare';
import type { RenderedViewEvent, ViewDelivery } from './view-delivery';
import { api, message, parseActivityDetail, type ActivityDetail, type CreatedInvite } from './api';

export function ActivityDetails({ id, actorId, journeyId, close, delivery }: { delivery: ViewDelivery; id: string; actorId: string; journeyId: string; close: () => void }) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.focus(); }, []);
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [detailActor, setDetailActor] = useState<string | null>(null);
  const live = useLiveActivity(id, detail, setDetail, detail?.id === id && detailActor === actorId);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewVersion, setViewVersion] = useState(0);
  // Held here, above the remounting view, and scoped to the actor that created it.
  const [shared, setShared] = useState<{ actorId: string; invite: CreatedInvite } | null>(null);
  const sharing = { invite: shared?.actorId === actorId ? shared.invite : null, onCreated: (invite: CreatedInvite) => setShared({ actorId, invite }) };
  const pending = useRef<AbortController | null>(null);
  const loadDetails = useCallback(async (renewView: boolean) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setError('');
    try {
      const data = await api(`/activities/${id}`, { actorId: actorId || undefined, signal: controller.signal });
      if (controller.signal.aborted) return;
      const activity = parseActivityDetail(data);
      setDetail(previous => {
        if (!previous || previous.id !== activity.id || activity.version >= previous.version) return activity;
        // Refresh this actor's policy even when live availability already has a newer version.
        return { ...previous, invitation: activity.invitation, assignment: activity.assignment, invitePolicy: activity.invitePolicy };
      });
      setDetailActor(actorId);
      if (renewView) setViewVersion(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setError(`Could not refresh activity details. ${message(error)}`);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [id, actorId]);
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
    {detail && detail.id === id && detailActor === actorId ? <RenderedActivity sharing={sharing} stale={live.stale} refresh={() => void loadDetails(false)} delivery={delivery} key={`${detail.id}:${actorId}:${viewVersion}`} activity={detail} actorId={actorId} journeyId={journeyId} /> : null}
  </section>;
}
type Sharing = { invite: CreatedInvite | null; onCreated: (invite: CreatedInvite) => void };
function RenderedActivity({ activity, actorId, journeyId, delivery, refresh, stale, sharing }: { stale: boolean; delivery: ViewDelivery; activity: ActivityDetail; actorId: string; journeyId: string; refresh: () => void; sharing: Sharing }) {
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
    <InvitationExperience activity={activity} actorId={actorId} journeyId={journeyId} delivery={delivery} sharing={sharing} />
    <SeatBooking stale={stale} activity={activity} actorId={actorId} journeyId={journeyId} refresh={refresh} />
    <h3>Confirmed participants</h3>
    {activity.participants.length ? <ul>{activity.participants.map(user => <li key={user.id}>{user.displayName}</li>)}</ul> :
      <p>No confirmed participants yet. Hosting does not consume a seat.</p>}
  </>;
}

function invitationCopy(reason: ActivityDetail['invitation']['policy']['reason']): string {
  switch (reason) {
    case 'allowed': return 'This activity is assigned to the invitation experience.';
    case 'creation_disabled': return 'New invitations are temporarily unavailable. You can still book a seat.';
    case 'control': return 'This activity supports ordinary booking. New invitations are unavailable.';
    case 'host_or_booker_required': return 'Book a seat or host this activity to create invitations.';
    case 'assignment_unavailable': return 'Invitation availability could not be verified. You can still book a seat.';
  }
}
function InvitationExperience({ activity, actorId, journeyId, delivery, sharing }: { activity: ActivityDetail; actorId: string; journeyId: string; delivery: ViewDelivery; sharing: Sharing }) {
  const headingId = useId();
  const { policy, assignment } = activity.invitation;
  const { allowed, creationEnabled, reason } = policy;
  const signature = JSON.stringify([assignment?.experiment, assignment?.version, assignment?.variant, allowed, creationEnabled, reason]);
  useEffect(() => {
    delivery.captureExposure({ id: crypto.randomUUID(), schemaVersion: 1, name: 'experiment_exposed', source: 'client', platform: 'web',
      occurredAt: new Date().toISOString(), actorId: actorId || undefined, journeyId, activityId: activity.id, planId: activity.planId,
      displayedInviteState: { enabled: allowed, creationEnabled, reason } }, `${activity.title} invitation experience`, signature);
  }, [delivery, actorId, journeyId, activity.id, activity.planId, activity.title, allowed, creationEnabled, reason, signature]);
  return <section aria-labelledby={headingId}>
    <h3 id={headingId}>Invitations</h3>
    <p>{invitationCopy(reason)}</p>
    <p className="hint">Invitations do not reserve seats. Only a confirmed booking holds a place.</p>
    {allowed && actorId ? <PublicShare activity={activity} actorId={actorId} journeyId={journeyId} invite={sharing.invite} onCreated={sharing.onCreated} /> : null}
  </section>;
}
