import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HostApp } from './HostApp';
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const identity = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Amara', generation: 0, acquisitionParentId: null, acquisitionRootId: '11111111-1111-4111-8111-111111111111', synthetic: false, test: false };
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
    if (url.endsWith('/events')) { events.push(JSON.parse(options.body as string)); return Promise.resolve(response({ accepted: true })); }
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
    if (url.endsWith('/events')) return Promise.resolve(response({ accepted: true }));
    if (url.endsWith('/activities') && options.method === 'GET') return Promise.resolve(response([]));
    return Promise.resolve(response(activity));
  }));
  render(<HostApp />);
  await screen.findByRole('option', { name: 'Amara' });
  fillActivity();
  fireEvent.click(screen.getByRole('button', { name: 'Create activity' }));
  expect(await screen.findByText('No confirmed participants yet. Hosting does not consume a seat.')).toBeTruthy();
  expect(screen.queryByText('Sunrise walk — Saving…')).toBeNull();
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
  finishList(new Response(JSON.stringify({ error: { message: 'Database unavailable.' }, requestId: 'outage' }), { status: 503 }));
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
      events.push(JSON.parse(options.body as string));
      return events.length === 1 ? Promise.reject(new Error('Telemetry unavailable.')) : Promise.resolve(response({ accepted: true }));
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
