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
const vouch = { id: '55555555-5555-4555-8555-555555555555', code: 'VCHR2345EFGH', rail: 'vouch', recipientContact: 'tunde@example.com', inviterRole: 'host',
  activityId: activity.id, planId: activity.planId, createdAt: '2026-10-08T12:00:00.000Z', expiresAt: '2026-10-09T12:00:00.000Z',
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

test('explains recipient matching, trust, demo limits, expiry and no reserved seat, then creates a vouch for one contact', async () => {
  const fetch = setup(async () => ok(vouch, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  const panel = await screen.findByRole('group', { name: 'Vouch for a contact' });
  for (const copy of [/only the person whose contact matches/i, /same format/i, /personally vouch/i, /not verified in this demo/i, /24 hours or when the activity starts/i,
    /does not reserve a seat/i, /3 of 4 seats remaining/]) {
    expect(within(panel).getByText(copy)).toBeTruthy();
  }
  fireEvent.change(within(panel).getByLabelText(/Contact's email or phone/), { target: { value: ' Tunde@Example.com ' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Create vouch' }));
  expect(await within(panel).findByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`)).toBeTruthy();
  expect(within(panel).getByText('VCHR-2345-EFGH')).toBeTruthy();
  expect(within(panel).getByRole('heading', { name: 'Vouch link for tunde@example.com' })).toBeTruthy();
  expect(within(panel).getByText(/Only tunde@example.com can claim/)).toBeTruthy();
  const [, options] = fetch.mock.calls.find(([url]) => String(url).endsWith('/invites'))!;
  expect(JSON.parse(options.body)).toEqual({ rail: 'vouch', recipientContact: 'Tunde@Example.com', platform: 'web', journeyId });
  // The public link panel keeps its own state.
  expect(within(screen.getByRole('group', { name: 'Public share link', hidden: true })).queryByDisplayValue(/VCHR2345EFGH/)).toBeNull();
});

test('a missing contact is explained before any request, and server rejections keep the entered contact', async () => {
  const fetch = setup(async () => new Response(JSON.stringify({ error: { code: 'SELF_INVITE', message: 'You cannot vouch for your own contact.', retryable: false }, requestId: 'ui-test' }), { status: 403 }));
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  const panel = await screen.findByRole('group', { name: 'Vouch for a contact' });
  fireEvent.click(within(panel).getByRole('button', { name: 'Create vouch' }));
  expect((await within(panel).findByRole('alert')).textContent).toMatch(/Enter the email address or phone number/);
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/invites'))).toBe(false);
  fireEvent.change(within(panel).getByLabelText(/Contact's email or phone/), { target: { value: 'me@example.com' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Create vouch' }));
  expect((await within(panel).findByRole('alert')).textContent).toMatch(/your own contact/);
  expect(within(panel).getByDisplayValue('me@example.com')).toBeTruthy();
});

test('a full activity cannot be vouched for', async () => {
  setup(async () => ok(vouch, 201), { ...activity, confirmedCount: 4, remainingSeats: 0 });
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  const panel = await screen.findByRole('group', { name: 'Vouch for a contact' });
  expect(within(panel).getByText(/No seats remain/)).toBeTruthy();
  expect(within(panel).getByRole('button', { name: 'Create vouch' }).hasAttribute('disabled')).toBe(true);
});

test('validation errors are tied to the contact input and creation is announced in a persistent status region', async () => {
  setup(async () => ok(vouch, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  const panel = await screen.findByRole('group', { name: 'Vouch for a contact' });
  const input = within(panel).getByLabelText(/Contact's email or phone/);
  const region = within(panel).getByRole('status');
  fireEvent.click(within(panel).getByRole('button', { name: 'Create vouch' }));
  const alert = await within(panel).findByRole('alert');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'tunde@example.com' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Create vouch' }));
  await waitFor(() => expect(region.textContent).toMatch(/Vouch created for tunde@example.com/));
  expect(input.getAttribute('aria-invalid')).toBe('false');
  expect(region.isConnected).toBe(true);
});

test('editing the contact hides the earlier link without implying it was revoked', async () => {
  setup(async () => ok(vouch, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  const panel = await screen.findByRole('group', { name: 'Vouch for a contact' });
  const input = within(panel).getByLabelText(/Contact's email or phone/);
  fireEvent.change(input, { target: { value: 'tunde@example.com' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Create vouch' }));
  await within(panel).findByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`);
  fireEvent.change(input, { target: { value: 'kemi@example.com' } });
  expect(within(panel).queryByDisplayValue(/VCHR2345EFGH/)).toBeNull();
  expect(within(panel).queryByText(/Only tunde@example.com can claim/)).toBeNull();
  expect(within(panel).getByRole('status').textContent).toMatch(/vouch for tunde@example.com was hidden.*still valid until it expires/i);
});

test('the draft, a pending creation and its result survive a details refresh, and reset when the actor changes', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) return Promise.resolve(ok({ id: JSON.parse(options.body as string).id, accepted: true }));
    if (url.endsWith('/invites')) return new Promise<Response>(resolve => { finish = resolve; });
    if (url.endsWith('/booking')) return Promise.resolve(ok({ booking: null, availability: { activityId: activity.id, planId: activity.planId, capacity: 4, confirmedCount: 1, remainingSeats: 3, version: 2 } }));
    return Promise.resolve(ok(activity));
  });
  vi.stubGlobal('fetch', fetch);
  const delivery = new ViewDelivery();
  const view = render(<ActivityDetails id={activity.id} actorId={actorId} journeyId={journeyId} close={() => {}} delivery={delivery} />);
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  const panel = () => screen.getByRole('group', { name: 'Vouch for a contact' });
  await screen.findByRole('group', { name: 'Vouch for a contact' });
  fireEvent.change(within(panel()).getByLabelText(/Contact's email or phone/), { target: { value: 'tunde@example.com' } });
  fireEvent.click(within(panel()).getByRole('button', { name: 'Create vouch' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith(activity.id)).length).toBe(2));
  await screen.findByRole('group', { name: 'Vouch for a contact' });
  expect(within(panel()).getByDisplayValue('tunde@example.com')).toBeTruthy();
  expect(within(panel()).getByRole('button', { name: 'Creating vouch…' }).hasAttribute('disabled')).toBe(true);
  finish(ok(vouch, 201));
  expect(await within(panel()).findByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith(activity.id)).length).toBe(3));
  expect(await within(panel()).findByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`)).toBeTruthy();
  view.rerender(<ActivityDetails id={activity.id} actorId="66666666-6666-4666-8666-666666666666" journeyId={journeyId} close={() => {}} delivery={delivery} />);
  await waitFor(() => expect(within(panel()).queryByDisplayValue(/VCHR2345EFGH|tunde@example.com/)).toBeNull());
  expect(within(panel()).getByRole('button', { name: 'Create vouch' }).hasAttribute('disabled')).toBe(false);
});

test('a response that arrives after switching identity away and back does not appear in the new session', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) return Promise.resolve(ok({ id: JSON.parse(options.body as string).id, accepted: true }));
    if (url.endsWith('/invites')) return new Promise<Response>(resolve => { finish = resolve; });
    if (url.endsWith('/booking')) return Promise.resolve(ok({ booking: null, availability: { activityId: activity.id, planId: activity.planId, capacity: 4, confirmedCount: 1, remainingSeats: 3, version: 2 } }));
    return Promise.resolve(ok(activity));
  }));
  const delivery = new ViewDelivery();
  const details = (actor: string) => <ActivityDetails id={activity.id} actorId={actor} journeyId={journeyId} close={() => {}} delivery={delivery} />;
  const view = render(details(actorId));
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  const panel = () => screen.getByRole('group', { name: 'Vouch for a contact' });
  await screen.findByRole('group', { name: 'Vouch for a contact' });
  const input = within(panel()).getByLabelText(/Contact's email or phone/);
  fireEvent.change(input, { target: { value: 'tunde@example.com' } });
  fireEvent.click(within(panel()).getByRole('button', { name: 'Create vouch' }));
  expect(within(panel()).getByLabelText(/Contact's email or phone/).hasAttribute('readonly')).toBe(true);
  view.rerender(details('66666666-6666-4666-8666-666666666666'));
  await screen.findByRole('button', { name: 'Create vouch' });
  view.rerender(details(actorId));
  await screen.findByRole('button', { name: 'Create vouch' });
  finish(ok(vouch, 201));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(within(panel()).queryByDisplayValue(/VCHR2345EFGH/)).toBeNull();
  expect(within(panel()).getByRole('status').textContent).toMatch(/previous vouch request may have completed/);
});


test('reload restores a vouch draft and issued link only for its actor and activity', async () => {
  setup(async () => ok(vouch, 201));
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  fireEvent.change(screen.getByLabelText(/Contact's email or phone/), { target: { value: 'tunde@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create vouch' }));
  await screen.findByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`);
  cleanup();
  const restored = render(<ActivityDetails id={activity.id} actorId="" journeyId={journeyId} close={() => {}} delivery={new ViewDelivery()} />);
  restored.rerender(<ActivityDetails id={activity.id} actorId={actorId} journeyId={journeyId} close={() => {}} delivery={new ViewDelivery()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  expect(screen.getByDisplayValue('tunde@example.com')).toBeTruthy();
  expect(screen.getByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`)).toBeTruthy();
  cleanup();
  render(<ActivityDetails id={activity.id} actorId="another-actor" journeyId={journeyId} close={() => {}} delivery={new ViewDelivery()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Vouch for a contact/ }));
  expect(screen.queryByDisplayValue('tunde@example.com')).toBeNull();
  expect(screen.queryByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`)).toBeNull();
});
