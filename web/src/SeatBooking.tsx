import { useEffect, useRef, useState } from 'react';
import { api, ApiError, message, parseBookingState, persist, stored, type Activity, type BookingState } from './api';

export function SeatBooking({ activity, actorId, journeyId, refresh, stale = false }: { stale?: boolean; activity: Activity; actorId: string; journeyId: string; refresh: () => void }) {
  const storageKey = `velio.booking.v1:${actorId}:${activity.id}`;
  const [initialKey] = useState(() => stored(storageKey));
  const [key] = useState(() => initialKey || crypto.randomUUID());
  const submitted = useRef(Boolean(initialKey));
  const [state, setState] = useState<BookingState | null>(null);
  const [phase, setPhase] = useState<'checking' | 'ready' | 'pending' | 'lookup_failed' | 'uncertain' | 'rejected' | 'confirmed'>('checking');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const active = useRef(false);
  const busy = useRef(false);
  const rejected = useRef(false);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    if (!actorId) { setPhase('ready'); return () => { active.current = false; }; }
    void api(`/activities/${activity.id}/booking`, { actorId, signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        const result = parseBookingState(value, activity, actorId);
        setState(result); setPhase(result.booking ? 'confirmed' : submitted.current ? 'uncertain' : 'ready');
      }).catch(error => {
        if (!controller.signal.aborted) { setError(message(error)); setPhase(submitted.current ? 'uncertain' : 'lookup_failed'); }
      });
    return () => { active.current = false; controller.abort(); };
  // The parent keys this component by activity and actor; snapshots do not restart recovery.
  }, [activity.id, actorId, storageKey]);

  async function check() {
    const result = parseBookingState(await api(`/activities/${activity.id}/booking`, { actorId }), activity, actorId);
    if (active.current) {
      setState(result);
      if (result.booking) { setPhase('confirmed'); setError(''); refresh(); }
      else { setPhase(rejected.current ? 'rejected' : submitted.current ? 'uncertain' : 'ready'); setError(''); }
    }
    return result;
  }
  async function submit() {
    if (busy.current || !actorId) return;
    busy.current = true;
    submitted.current = true;
    setPhase('pending'); setError('');
    if (!persist(storageKey, key)) setWarning('Browser storage is unavailable. Reopen this activity with the same identity to check confirmation after a reload.');
    try {
      const result = parseBookingState(await api(`/activities/${activity.id}/bookings`, {
        actorId, idempotencyKey: key, body: { platform: 'web', journeyId },
      }), activity, actorId);
      if (!result.booking) throw new Error('Confirmation is missing.');
      if (active.current) {
        setState(result); setPhase('confirmed'); refresh();
        if (result.telemetry === 'degraded') setWarning('Your booking is confirmed, but request tracking could not be saved.');
      }
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiError && !error.retryable) {
        rejected.current = true;
        submitted.current = false;
        persist(storageKey, '');
        setError(message(error)); setPhase('rejected'); refresh();
      } else {
        setPhase('checking'); setError('Checking your confirmation after an uncertain response.');
        try {
          const result = await check();
          if (active.current && !result.booking) setError('Your confirmation is unresolved. Check again or retry with the same request key.');
        } catch (lookupError) {
          if (active.current) { setPhase('uncertain'); setError(`Your confirmation is unresolved. ${message(lookupError)}`); }
        }
      }
    } finally { busy.current = false; }
  }
  async function recover() {
    if (busy.current) return;
    busy.current = true; setPhase('checking'); setError('');
    try { await check(); }
    catch (error) { if (active.current) { setPhase(rejected.current ? 'rejected' : submitted.current ? 'uncertain' : 'lookup_failed'); setError(message(error)); } }
    finally { busy.current = false; }
  }
  const booking = state?.booking;
  const seats = Math.min(activity.remainingSeats, state?.availability.remainingSeats ?? activity.remainingSeats);
  const unavailable = activity.status !== 'scheduled' || Date.parse(activity.startsAt) <= Date.now() || seats === 0;
  return <section aria-label="Your booking" aria-live="polite">
    {stale ? <p>Availability may be stale. Live recovery must finish before a new booking.</p> : null}
    {!actorId ? <p>Select a demo identity to book one seat.</p> : <>
      {phase === 'confirmed' && booking ? <>
        <p>Your seat is confirmed.</p>
        <p>Booking: {booking.id} · Plan: {booking.planId}</p>
        <p>Confirmed price: {booking.priceMinor} {booking.currency} minor units. This demo does not collect payment.</p>
      </> : <>
        {phase === 'checking' ? <p role="status">Checking your confirmation…</p> : null}
        {unavailable && phase !== 'uncertain' ? <p>{seats === 0 ? 'This activity is sold out.' : 'This activity is no longer bookable.'}</p> : null}
        <button disabled={(stale && phase !== 'uncertain') || phase === 'pending' || phase === 'checking' || phase === 'lookup_failed' || (unavailable && phase !== 'uncertain') || phase === 'rejected'} onClick={() => void submit()}>
          {phase === 'pending' ? 'Booking your seat…' : phase === 'uncertain' ? 'Retry same booking request' : 'Book one seat'}
        </button>
        {phase === 'lookup_failed' || phase === 'uncertain' || phase === 'rejected' ? <button onClick={() => void recover()}>{phase === 'lookup_failed' ? 'Retry confirmation lookup' : 'Check confirmation'}</button> : null}
      </>}
      {error ? <p role="alert">{error}</p> : null}
      {warning ? <p role="status">{warning}</p> : null}
    </>}
  </section>;
}
