import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HostApp } from './HostApp';
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const identity = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Amara', generation: 0, acquisitionParentId: null, acquisitionRootId: '11111111-1111-4111-8111-111111111111', acquisitionRail: null, synthetic: false, test: false };
function response(data: unknown) { return new Response(JSON.stringify({ data, requestId: 'ui-test' })); }
test('selects and persists a clearly labelled demo identity across reloads', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/identities') ? [identity] : []))));
  const view = render(<HostApp />);
  expect(await screen.findByRole('option', { name: 'Amara' })).toBeTruthy();
  expect(screen.getByText(/Demo identities are not verified authentication/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Demo identity'), { target: { value: identity.id } });
  view.unmount();
  render(<HostApp />);
  await screen.findByRole('option', { name: 'Amara' });
  await waitFor(() => expect((screen.getByLabelText('Demo identity') as HTMLSelectElement).value).toBe(identity.id));
});

function fillActivity() {
  for (const [label, value] of [['Title', 'Sunrise walk'], ['Description', 'A gentle walk.'], ['Meeting location', 'Marina gate'],
    ['Start date and time (device timezone)', '2030-01-15T07:00'], ['Display timezone (IANA)', 'Africa/Lagos'], ['Capacity', '2'], ['Price (minor units)', '1500'], ['Currency', 'NGN']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
}
test('shows a reversible pending activity and preserves the form after rejection', async () => {
  let rejectCreation!: (value: Response) => void;
  localStorage.setItem('velio.actor.v1', identity.id);
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([identity]));
    if (options.method === 'POST') return new Promise<Response>(resolve => { rejectCreation = resolve; });
    return Promise.resolve(response([]));
  }));
  render(<HostApp />);
  await screen.findByRole('option', { name: 'Amara' });
  fillActivity();
  fireEvent.click(screen.getByRole('button', { name: 'Create activity' }));
  expect(await screen.findByText('Sunrise walk — Saving…')).toBeTruthy();
  rejectCreation(new Response(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Creation rejected.', retryable: false }, requestId: 'reject' }), { status: 400 }));
  expect(await screen.findByText(/Creation rejected/)).toBeTruthy();
  expect(screen.queryByText('Sunrise walk — Saving…')).toBeNull();
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Sunrise walk');
  expect(screen.getByRole('button', { name: 'Create activity' }).hasAttribute('disabled')).toBe(false);
});

const activity = { id: '22222222-2222-4222-8222-222222222222', hostId: identity.id, title: 'Sunrise walk', description: 'A gentle walk.', meetingLocation: 'Marina gate',
  startsAt: '2030-01-15T07:00:00.000Z', timezone: 'Africa/Lagos', capacity: 2, confirmedCount: 0, remainingSeats: 2, priceMinor: 1500,
  currency: 'NGN', version: 1, status: 'scheduled', planId: '33333333-3333-4333-8333-333333333333', participants: [] };
test('shows authoritative details and records a rendered view, including anonymous context', async () => {
  const events: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([identity]));
    if (url.endsWith('/events')) {
      if (JSON.parse(options.body as string).name === 'experiment_exposed') return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true})); events.push(JSON.parse(options.body as string)); return Promise.resolve(response({ id: JSON.parse(options.body as string).id, accepted: true })); }
    return Promise.resolve(response(url.endsWith('/activities') ? [activity] : activity));
  }));
  render(<HostApp />);
  fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
  expect(await screen.findByText('No confirmed participants yet. Hosting does not consume a seat.')).toBeTruthy();
  expect(screen.getByText('Marina gate')).toBeTruthy();
  expect(screen.getByText(`Shared plan: ${activity.planId}`)).toBeTruthy();
  await waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]).toMatchObject({ name: 'activity_viewed', source: 'client', schemaVersion: 1, platform: 'web', activityId: activity.id, planId: activity.planId });
  expect(events[0]?.journeyId).toBe(localStorage.getItem('velio.journey.v1'));
});

test('committed creation replaces the pending entry, opens authoritative details and clears the form', async () => {
  localStorage.setItem('velio.actor.v1', identity.id);
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([identity]));
    if (url.endsWith('/events')) return Promise.resolve(response({ id: JSON.parse(options.body as string).id, accepted: true }));
    if (url.endsWith('/activities') && options.method === 'GET') return Promise.resolve(response([]));
    return Promise.resolve(response(activity));
  }));
  render(<HostApp />);
  await screen.findByRole('option', { name: 'Amara' });
  fillActivity();
  fireEvent.change(screen.getByLabelText('Display timezone (IANA)'), { target: { value: 'africa/lagos' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create activity' }));
  expect(await screen.findByText('No confirmed participants yet. Hosting does not consume a seat.')).toBeTruthy();
  expect(screen.queryByText('Sunrise walk — Saving…')).toBeNull();
  const details = within(screen.getByRole('region', { name: 'Activity details' }));
  expect(details.getByText(/\(Africa\/Lagos\)$/).textContent).toContain('8:00');
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
});

test('identity creation selects the durable actor and switching persists the replacement', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response(options.method === 'POST' ? identity : []));
    return Promise.resolve(response([]));
  }));
  render(<HostApp />);
  await screen.findByText('No demo identities yet. Create one to host an activity.');
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Amara' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create demo identity' }));
  await screen.findByRole('option', { name: 'Amara' });
  expect(localStorage.getItem('velio.actor.v1')).toBe(identity.id);
  fireEvent.change(screen.getByLabelText('Demo identity'), { target: { value: '' } });
  expect(localStorage.getItem('velio.actor.v1')).toBe('');
});

test('activity discovery exposes loading, empty, error and retry states', async () => {
  let finishList!: (response: Response) => void;
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([]));
    calls++;
    return calls === 1 ? new Promise<Response>(resolve => { finishList = resolve; }) : Promise.resolve(response([]));
  }));
  render(<HostApp />);
  expect(screen.getByText('Loading activities…')).toBeTruthy();
  finishList(new Response(JSON.stringify({ error: { code: 'DEPENDENCIES_UNAVAILABLE', message: 'Database unavailable.', retryable: true }, requestId: 'outage' }), { status: 503 }));
  expect(await screen.findByText(/Database unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh activities' }));
  expect(await screen.findByText('No activities yet. Be the first to host one.')).toBeTruthy();
});

test('client rejects whitespace-only activity fields before sending a creation request', async () => {
  localStorage.setItem('velio.actor.v1', identity.id);
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === 'POST') writes.push(options.body);
    return Promise.resolve(response(url.endsWith('/identities') ? [identity] : []));
  }));
  render(<HostApp />);
  await screen.findByRole('option', { name: 'Amara' });
  fillActivity();
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create activity' }));
  expect(await screen.findByText(/Enter a title, description and meeting location/)).toBeTruthy();
  expect(writes).toHaveLength(0);
});

test('failed view tracking retries the same event without hiding authoritative details', async () => {
  const events: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([]));
    if (url.endsWith('/events')) {
      if (JSON.parse(options.body as string).name === 'experiment_exposed') return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true}));
      events.push(JSON.parse(options.body as string));
      return events.length === 1 ? Promise.reject(new Error('Telemetry unavailable.')) : Promise.resolve(response({ id: JSON.parse(options.body as string).id, accepted: true }));
    }
    return Promise.resolve(response(url.endsWith('/activities') ? [activity] : activity));
  }));
  render(<HostApp />);
  fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
  expect(await screen.findByText(/View tracking could not be saved/)).toBeTruthy();
  expect(screen.getByText('Marina gate')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry view tracking' }));
  await waitFor(() => expect(events).toHaveLength(2));
  expect(events[1]?.id).toBe(events[0]?.id);
});

test('rendered view delivery survives closing details and retries its original context after an identity switch', async () => {
  const secondIdentity = { ...identity, id: '44444444-4444-4444-8444-444444444444', displayName: 'Tunde', acquisitionRootId: '44444444-4444-4444-8444-444444444444' };
  localStorage.setItem('velio.actor.v1', identity.id);
  const events: { body: Record<string, unknown>; signal: AbortSignal; actor: string }[] = [];
  let failFirst!: (reason: Error) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([identity, secondIdentity]));
    if (url.endsWith('/events')) {
      if (JSON.parse(options.body as string).name === 'experiment_exposed') return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true}));
      const body = JSON.parse(options.body as string);
      events.push({ body, signal: options.signal as AbortSignal, actor: (options.headers as Record<string, string>)['X-Demo-Actor-Id']! });
      return events.length === 1 ? new Promise<Response>((_resolve, reject) => { failFirst = reject; }) : Promise.resolve(response({ id: body.id, accepted: false }));
    }
    return Promise.resolve(response(url.endsWith('/activities') ? [activity] : activity));
  }));
  render(<HostApp />);
  await screen.findByRole('option', { name: 'Amara' });
  fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
  await screen.findByText('Marina gate');
  await waitFor(() => expect(events).toHaveLength(1));
  const original = events[0]!;
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(original.signal.aborted).toBe(false);
  fireEvent.change(screen.getByLabelText('Demo identity'), { target: { value: secondIdentity.id } });
  failFirst(new Error('Telemetry unavailable.'));
  expect(await screen.findByText(/View tracking could not be saved/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry view tracking' }));
  await waitFor(() => expect(events).toHaveLength(2));
  expect(events[1]!.body).toEqual(original.body);
  expect(events[1]!.actor).toBe(identity.id);
  await waitFor(() => expect(screen.queryByText(/View tracking could not be saved/)).toBeNull());
});

for (const navigation of ['another activity', 'another identity', 'details refresh'] as const) {
  test(`pending view survives navigation to ${navigation} and retries its captured event`, async () => {
    const secondIdentity = { ...identity, id: '44444444-4444-4444-8444-444444444444', displayName: 'Tunde', acquisitionRootId: '44444444-4444-4444-8444-444444444444' };
    const secondActivity = { ...activity, id: '55555555-5555-4555-8555-555555555555', title: 'Evening picnic', planId: '66666666-6666-4666-8666-666666666666' };
    localStorage.setItem('velio.actor.v1', identity.id);
    const events: { body: Record<string, unknown>; signal: AbortSignal; actor: string }[] = [];
    let failFirst!: (reason: Error) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (url.endsWith('/identities')) return Promise.resolve(response([identity, secondIdentity]));
      if (url.endsWith('/events')) {
      if (JSON.parse(options.body as string).name === 'experiment_exposed') return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true}));
        const body = JSON.parse(options.body as string);
        events.push({ body, signal: options.signal as AbortSignal, actor: (options.headers as Record<string, string>)['X-Demo-Actor-Id']! });
        return events.length === 1 ? new Promise<Response>((_resolve, reject) => { failFirst = reject; }) : Promise.resolve(response({ id: body.id, accepted: true }));
      }
      if (url.endsWith('/activities')) return Promise.resolve(response([activity, secondActivity]));
      return Promise.resolve(response(url.endsWith(secondActivity.id) ? secondActivity : activity));
    }));
    render(<HostApp />);
    await screen.findByRole('option', { name: 'Amara' });
    fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
    await waitFor(() => expect(events).toHaveLength(1));
    const original = events[0]!;
    if (navigation === 'another activity') fireEvent.click(screen.getByRole('button', { name: 'View Evening picnic' }));
    if (navigation === 'another identity') fireEvent.change(screen.getByLabelText('Demo identity'), { target: { value: secondIdentity.id } });
    if (navigation === 'details refresh') fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
    await waitFor(() => expect(events).toHaveLength(2));
    expect(original.signal.aborted).toBe(false);
    expect(events[1]!.body.id).not.toBe(original.body.id);
    if (navigation === 'another identity') expect(events[1]!.actor).toBe(secondIdentity.id);
    if (navigation === 'another activity') expect(events[1]!.body.activityId).toBe(secondActivity.id);
    failFirst(new Error('Original delivery failed.'));
    await screen.findByText(/Original delivery failed/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry view tracking' }));
    await waitFor(() => expect(events).toHaveLength(3));
    expect(events[2]!.body).toEqual(original.body);
    expect(events[2]!.actor).toBe(identity.id);
    await waitFor(() => expect(screen.queryByText(/Original delivery failed/)).toBeNull());
  });
}

test('StrictMode replay does not change a captured view event or cancel its delivery', async () => {
  const events: { body: Record<string, unknown>; signal: AbortSignal }[] = [];
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([]));
    if (url.endsWith('/events')) {
      if (JSON.parse(options.body as string).name === 'experiment_exposed') return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true}));
      events.push({ body: JSON.parse(options.body as string), signal: options.signal as AbortSignal });
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return Promise.resolve(response(url.endsWith('/activities') ? [activity] : activity));
  }));
  render(<StrictMode><HostApp /></StrictMode>);
  fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
  await waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]!.signal.aborted).toBe(false);
  finish(response({ id: events[0]!.body.id, accepted: true }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'View tracking delivery' })).toBeNull());
});

test('a delivery timeout stays observable after details close', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response([]));
    if (url.endsWith('/events')) {
      if (JSON.parse(options.body as string).name === 'experiment_exposed') return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true}));
      return new Promise<Response>((_resolve, reject) => {
      const signal = options.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }); }
    return Promise.resolve(response(url.endsWith('/activities') ? [activity] : activity));
  }));
  render(<HostApp />);
  fireEvent.click(await screen.findByRole('button', { name: 'View Sunrise walk' }));
  await screen.findByText('Saving 1 rendered view event…');
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(await screen.findByText(/View tracking could not be saved/, {}, { timeout: 9000 })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry view tracking' })).toBeTruthy();
}, 10000);

test('identity creation sends an optional demo contact only when one is entered', async () => {
  const fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/identities')) return Promise.resolve(response(options.method === 'POST' ? identity : []));
    return Promise.resolve(response([]));
  });
  vi.stubGlobal('fetch', fetch);
  render(<HostApp />);
  await screen.findByText('No demo identities yet. Create one to host an activity.');
  expect(screen.getByText(/contact is not verified/)).toBeTruthy();
  expect(screen.getByText(/use the same format the inviter will enter/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Tunde' } });
  fireEvent.change(screen.getByLabelText(/Contact for vouches/), { target: { value: ' tunde@example.com ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create demo identity' }));
  await screen.findByRole('option', { name: 'Amara' });
  const posts = fetch.mock.calls.filter(([url, options]) => String(url).endsWith('/identities') && options.method === 'POST');
  expect(JSON.parse(posts[0]![1].body)).toMatchObject({ displayName: 'Tunde', contact: 'tunde@example.com' });
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Kemi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create demo identity' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url, options]) => String(url).endsWith('/identities') && options.method === 'POST').length).toBe(2));
  const second = JSON.parse(fetch.mock.calls.filter(([url, options]) => String(url).endsWith('/identities') && options.method === 'POST')[1]![1].body);
  expect('contact' in second).toBe(false);
});
