import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HostApp } from './HostApp';
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const actorId = '11111111-1111-4111-8111-111111111111';
const activity = { id: '22222222-2222-4222-8222-222222222222', hostId: actorId, title: 'Sunrise walk', description: 'A gentle walk.', meetingLocation: 'Marina gate',
  startsAt: '2030-01-15T07:00:00.000Z', timezone: 'Africa/Lagos', capacity: 1, confirmedCount: 0, remainingSeats: 1, priceMinor: 1500,
  currency: 'NGN', version: 1, status: 'scheduled', planId: '33333333-3333-4333-8333-333333333333', participants: [] };
const booking = { id: '44444444-4444-4444-8444-444444444444', activityId: activity.id, planId: activity.planId, userId: actorId, priceMinor: 1500, currency: 'NGN', confirmedAt: '2026-10-08T12:00:00Z' };
const snapshot = { activityId: activity.id, planId: activity.planId, capacity: 1, remainingSeats: 0, confirmedCount: 1, version: 2 };
function response(data: unknown) { return new Response(JSON.stringify({ data, requestId: 'ui-test' })); }
function setup(write: (options: RequestInit) => Promise<Response>, lookup: () => unknown = () => ({ booking: null, availability: { ...snapshot, remainingSeats: 1, confirmedCount: 0, version: 1 } }), details: () => typeof activity = () => activity) {
  localStorage.setItem('velio.actor.v1', actorId);
  // The rendered booking seam now requires a recovered live snapshot before a new write.
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(value: string) {
      if (JSON.parse(value).type !== 'subscribe') return;
      const detail = details();
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', eventId: null,
        activityId: detail.id, version: detail.version, activity: detail }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  });
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([{ id: actorId, displayName: 'Amara', generation: 0, acquisitionParentId: null, acquisitionRootId: actorId, acquisitionRail: null, synthetic: false, test: false }]));
    if (url.endsWith('/events')) return Promise.resolve(response({ accepted: true }));
    if (url.endsWith('/bookings')) return write(options);
    if (url.endsWith('/booking')) return Promise.resolve(response(lookup()));
    return Promise.resolve(response(url.endsWith('/activities') ? [details()] : details()));
  }));
  render(<HostApp />);
}
async function open() {
  await screen.findByRole('option', { name: 'Amara' });
  fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(false));
}
test('a seat remains pending until commit and repeated taps do not send another write', async () => {
  let finish!: (response: Response) => void;
  const write = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  setup(write);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  expect(await screen.findByText('Booking your seat…')).toBeTruthy();
  expect(screen.queryByText('Your seat is confirmed.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Booking your seat…' }).hasAttribute('disabled')).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  finish(response({ booking, availability: snapshot, replayed: false, telemetry: 'ok' }));
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
});

test('a lost committed response restores confirmation from own-booking lookup', async () => {
  let committed = false;
  setup(async () => { committed = true; throw new TypeError('Connection dropped'); }, () => ({ booking: committed ? booking : null, availability: committed ? snapshot : { ...snapshot, remainingSeats: 1, confirmedCount: 0, version: 1 } }));
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry same booking request' })).toBeNull();
});

test('an unresolved write persists its key across closing and reopening and retries that key', async () => {
  const keys: string[] = [];
  setup(async options => {
    keys.push((options.headers as Record<string, string>)['Idempotency-Key']!);
    if (keys.length === 1) throw new TypeError('Disconnected');
    return response({ booking, availability: snapshot, telemetry: 'ok' });
  });
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  await screen.findByRole('button', { name: 'Retry same booking request' });
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  fireEvent.click(screen.getByRole('button', { name: 'View Sunrise walk' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same booking request' }));
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test('a sold-out race retains details and explains the lost seat without confirmation', async () => {
  setup(async () => new Response(JSON.stringify({ error: { code: 'SOLD_OUT', message: 'The last spot was just taken.', retryable: false }, requestId: 'race' }), { status: 409 }));
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  expect(await screen.findByText(/The last spot was just taken/)).toBeTruthy();
  expect(screen.getByText('Marina gate')).toBeTruthy();
  expect(screen.queryByText('Your seat is confirmed.')).toBeNull();
});

test('a booked user reopens confirmation even when the activity is full', async () => {
  const write = vi.fn();
  setup(write, () => ({ booking, availability: snapshot }));
  await screen.findByRole('option', { name: 'Amara' });
  fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
  expect(write).not.toHaveBeenCalled();
});

test('a post-commit tracking failure warns without hiding the confirmed booking', async () => {
  setup(async () => response({ booking, availability: snapshot, telemetry: 'degraded' }));
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
  expect(screen.getByText(/request tracking could not be saved/)).toBeTruthy();
});

for (const code of ['SOLD_OUT', 'ACTIVITY_STARTED', 'ACTIVITY_UNAVAILABLE']) {
  test(`a definitive ${code} rejection stays settled after checking and reopening`, async () => {
    let rejected = false;
    const write = vi.fn().mockImplementation(async () => {
      rejected = true;
      return new Response(JSON.stringify({ error: { code, message: 'Activity cannot be booked.', retryable: false }, requestId: 'rejection' }), { status: 409 });
    });
    setup(write, () => ({ booking: null, availability: rejected && code === 'SOLD_OUT' ? snapshot : { ...snapshot, remainingSeats: 1, confirmedCount: 0, version: 1 } }),
      () => rejected ? { ...activity, status: code === 'ACTIVITY_UNAVAILABLE' ? 'cancelled' : 'scheduled',
        startsAt: code === 'ACTIVITY_STARTED' ? '2020-01-01T00:00:00Z' : activity.startsAt,
        remainingSeats: code === 'SOLD_OUT' ? 0 : 1 } : activity);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
    await screen.findByText(/Activity cannot be booked/);
    fireEvent.click(screen.getByRole('button', { name: 'Check confirmation' }));
    await waitFor(() => expect(screen.queryByText('Checking your confirmation…')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Retry same booking request' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.click(screen.getByRole('button', { name: 'View Sunrise walk' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Retry same booking request' })).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });
}

test('a failed confirmation check keeps a definitive rejection settled', async () => {
  let rejected = false;
  setup(async () => {
    rejected = true;
    return new Response(JSON.stringify({ error: { code: 'ACTIVITY_UNAVAILABLE', message: 'Activity is cancelled.', retryable: false }, requestId: 'cancelled' }), { status: 409 });
  }, () => {
    if (rejected) throw new TypeError('Connection lost during lookup');
    return { booking: null, availability: { ...snapshot, remainingSeats: 1, confirmedCount: 0, version: 1 } };
  }, () => rejected ? { ...activity, status: 'cancelled' } : activity);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  await screen.findByText(/Activity is cancelled/);
  fireEvent.click(screen.getByRole('button', { name: 'Check confirmation' }));
  await screen.findByText(/Connection lost during lookup/);
  expect(screen.queryByRole('button', { name: 'Retry same booking request' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
});

for (const unavailable of ['full', 'started', 'cancelled']) {
  test(`failed initial lookup for ${unavailable} offers only lookup recovery without an intent`, async () => {
    let failed = true;
    const detail = { ...activity, status: unavailable === 'cancelled' ? 'cancelled' : 'scheduled',
      startsAt: unavailable === 'started' ? '2020-01-01T00:00:00Z' : activity.startsAt,
      remainingSeats: unavailable === 'full' ? 0 : 1, confirmedCount: unavailable === 'full' ? 1 : 0 };
    const write = vi.fn();
    setup(write, () => {
      if (failed) throw new TypeError('Initial lookup unavailable');
      return { booking: null, availability: { ...snapshot, remainingSeats: detail.remainingSeats, confirmedCount: detail.confirmedCount } };
    }, () => detail);
    await screen.findByRole('option', { name: 'Amara' });
    fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
    await screen.findByText(/Initial lookup unavailable/);
    expect(screen.queryByRole('button', { name: 'Retry same booking request' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
    expect(localStorage.getItem(`velio.booking.v1:${actorId}:${activity.id}`)).toBeNull();
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry confirmation lookup' }));
    await waitFor(() => expect(screen.queryByText(/Initial lookup unavailable/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Retry same booking request' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
}

test('a missing-participants automatic refresh preserves confirmation and existing usable details', async () => {
  let committed = false;
  setup(async () => { committed = true; return response({ booking, availability: snapshot, telemetry: 'ok' }); }, undefined,
    () => committed ? { ...activity, participants: undefined } as unknown as typeof activity : activity);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
  expect(await screen.findByText(/Could not refresh activity details.*participants/)).toBeTruthy();
  expect(screen.getByText('Marina gate')).toBeTruthy();
  expect(screen.getByText('No confirmed participants yet. Hosting does not consume a seat.')).toBeTruthy();
});

test('genuine uncertainty retains its submitted key through failed lookup and reopening', async () => {
  const keys: string[] = [];
  setup(async options => {
    keys.push((options.headers as Record<string, string>)['Idempotency-Key']!);
    if (keys.length === 1) throw new TypeError('Lost submission response');
    return response({ booking, availability: snapshot, telemetry: 'ok' });
  }, () => {
    if (keys.length) throw new TypeError('Confirmation lookup unavailable');
    return { booking: null, availability: { ...snapshot, remainingSeats: 1, confirmedCount: 0, version: 1 } };
  }, () => keys.length ? { ...activity, remainingSeats: 0, confirmedCount: 1 } : activity);
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Book one seat' }));
  await screen.findByRole('button', { name: 'Retry same booking request' });
  expect(localStorage.getItem(`velio.booking.v1:${actorId}:${activity.id}`)).toBe(keys[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  fireEvent.click(screen.getByRole('button', { name: 'View Sunrise walk' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same booking request' }));
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test('manual refresh also rejects missing participants without replacing usable details', async () => {
  let partial = false;
  setup(vi.fn(), undefined, () => partial ? { ...activity, participants: undefined } as unknown as typeof activity : activity);
  await open();
  partial = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
  expect(await screen.findByText(/Could not refresh activity details.*participants/)).toBeTruthy();
  expect(screen.getByText('Marina gate')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(false);
});
