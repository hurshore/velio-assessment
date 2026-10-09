// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ActivityDetails } from './ActivityDetails';
import { ViewDelivery } from './view-delivery';

const actorId = '11111111-1111-4111-8111-111111111111';
const journeyId = '44444444-4444-4444-8444-444444444444';
const activity = { id: '22222222-2222-4222-8222-222222222222', hostId: actorId, title: 'Cohort walk', description: 'A gentle walk.', meetingLocation: 'Marina gate',
  startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity: 4, confirmedCount: 1, remainingSeats: 3,
  priceMinor: 0, currency: 'NGN', version: 2, status: 'scheduled', planId: '33333333-3333-4333-8333-333333333333', participants: [],
  assignment: { experiment: 'group_invites_v1', version: '1', treatmentPercent: 50, variant: 'treatment', assignedAt: '2026-10-08T12:00:00Z' },
  invitePolicy: { creationEnabled: true, allowed: true, reason: 'allowed' } };
const invite = { id: '55555555-5555-4555-8555-555555555555', code: 'ABCD2345EFGH', rail: 'public', inviterRole: 'host', activityId: activity.id,
  planId: activity.planId, createdAt: '2026-10-08T12:00:00.000Z', expiresAt: '2026-10-09T12:00:00.000Z',
  availability: { capacity: 4, confirmedCount: 1, remainingSeats: 3, version: 2 } };
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, requestId: 'ui-test' }), { status });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function setup(create: (options: RequestInit) => Promise<Response>, detail = activity) {
  const fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) return Promise.resolve(ok({ id: JSON.parse(options.body as string).id, accepted: true }));
    if (url.endsWith('/invites')) return create(options);
    if (url.endsWith('/booking')) return Promise.resolve(ok({ booking: null, availability: { activityId: activity.id, planId: activity.planId, capacity: 4, confirmedCount: 1, remainingSeats: 3, version: 2 } }));
    return Promise.resolve(ok(detail));
  });
  vi.stubGlobal('fetch', fetch);
  render(<ActivityDetails id={activity.id} actorId={actorId} journeyId={journeyId} close={() => {}} delivery={new ViewDelivery()} />);
  return fetch;
}

test('explains public trust and remaining seats before creating, then offers a copyable link', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const fetch = setup(async () => ok(invite, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  const button = await screen.findByRole('button', { name: 'Create public link' });
  const panel = within(screen.getByRole('group', { name: 'Public share link' }));
  expect(panel.getByText(/3 of 4 seats remaining/)).toBeTruthy();
  expect(panel.getByText(/Anyone with this link/)).toBeTruthy();
  expect(panel.getByText(/does not reserve a seat/)).toBeTruthy();
  expect(panel.getByText(/not a personal vouch/)).toBeTruthy();
  fireEvent.click(button);
  const link = `${window.location.origin}/invite/ABCD2345EFGH`;
  expect(await screen.findByDisplayValue(link)).toBeTruthy();
  expect(screen.getByText('ABCD-2345-EFGH')).toBeTruthy();
  const [, options] = fetch.mock.calls.find(([url]) => String(url).endsWith('/invites'))!;
  expect(JSON.parse(options.body)).toEqual({ rail: 'public', platform: 'web', journeyId });
  expect(options.headers['X-Demo-Actor-Id']).toBe(actorId);
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(link));
  expect(await screen.findByText('Link copied.')).toBeTruthy();
});

test('uses the device share sheet when available and keeps the link if sharing is cancelled', async () => {
  const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  vi.stubGlobal('navigator', { ...navigator, share });
  setup(async () => ok(invite, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create public link' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Share link' }));
  await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${window.location.origin}/invite/ABCD2345EFGH` })));
  expect(screen.getByDisplayValue(`${window.location.origin}/invite/ABCD2345EFGH`)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a rejected creation explains the reason and keeps the panel usable', async () => {
  setup(async () => new Response(JSON.stringify({ error: { code: 'INVITE_CREATION_UNAVAILABLE', message: 'New invitations are unavailable for this activity or identity.', retryable: false }, requestId: 'ui-test' }), { status: 403 }));
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create public link' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/New invitations are unavailable/);
  expect(screen.getByRole('button', { name: 'Create public link' }).hasAttribute('disabled')).toBe(false);
});

test('a full activity explains why it cannot be shared', async () => {
  setup(async () => ok(invite, 201), { ...activity, confirmedCount: 4, remainingSeats: 0 });
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  expect(await screen.findByText(/No seats remain, so there is nothing to share/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create public link' }).hasAttribute('disabled')).toBe(true);
});

test('a created link survives refreshing details but is cleared when the actor changes', async () => {
  const fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) return Promise.resolve(ok({ id: JSON.parse(options.body as string).id, accepted: true }));
    if (url.endsWith('/invites')) return Promise.resolve(ok(invite, 201));
    if (url.endsWith('/booking')) return Promise.resolve(ok({ booking: null, availability: { activityId: activity.id, planId: activity.planId, capacity: 4, confirmedCount: 1, remainingSeats: 3, version: 2 } }));
    return Promise.resolve(ok(activity));
  });
  vi.stubGlobal('fetch', fetch);
  const delivery = new ViewDelivery();
  const view = render(<ActivityDetails id={activity.id} actorId={actorId} journeyId={journeyId} close={() => {}} delivery={delivery} />);
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create public link' }));
  const link = `${window.location.origin}/invite/ABCD2345EFGH`;
  await screen.findByDisplayValue(link);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith(activity.id)).length).toBe(2));
  expect(await screen.findByDisplayValue(link)).toBeTruthy();
  view.rerender(<ActivityDetails id={activity.id} actorId="66666666-6666-4666-8666-666666666666" journeyId={journeyId} close={() => {}} delivery={delivery} />);
  await waitFor(() => expect(screen.queryByDisplayValue(link)).toBeNull());
});

test('copy feedback is announced from a mounted status region and cleared when a new link is created', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  setup(async () => ok(invite, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create public link' }));
  const panel = screen.getByRole('group', { name: 'Public share link' });
  await within(panel).findByDisplayValue(`${window.location.origin}/invite/ABCD2345EFGH`);
  const region = within(panel).getByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(region.textContent).toBe('Link copied.'));
  fireEvent.click(screen.getByRole('button', { name: 'Create public link' }));
  await waitFor(() => expect(region.textContent).toBe(''));
  expect(region.isConnected).toBe(true);
});

test('a created invite missing contract fields is reported instead of shown', async () => {
  setup(async () => ok({ ...invite, planId: undefined }, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create public link' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/unexpected invitation/);
  expect(screen.queryByText('ABCD-2345-EFGH')).toBeNull();
});


test('a public request stays pending through refresh and issued links survive reload only for their owner', async () => {
  let finish!: (response: Response) => void;
  setup(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create public link' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh details' }).hasAttribute('disabled')).toBe(false));
  expect(screen.getByRole('button', { name: 'Creating link…' }).hasAttribute('disabled')).toBe(true);
  finish(ok(invite));
  const link = `${window.location.origin}/invite/${invite.code}`;
  await screen.findByDisplayValue(link);
  cleanup();
  setup(async () => { throw new Error('Reload must not create another link'); });
  fireEvent.click(await screen.findByRole('button', { name: /Share a public link/ }));
  expect(await screen.findByDisplayValue(link)).toBeTruthy();
});
