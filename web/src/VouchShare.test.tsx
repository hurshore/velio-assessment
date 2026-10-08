// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  const panel = await screen.findByRole('group', { name: 'Vouch for a contact' });
  for (const copy of [/only the person whose contact matches/i, /personally vouch/i, /not verified in this demo/i, /24 hours or when the activity starts/i,
    /does not reserve a seat/i, /3 of 4 seats remaining/]) {
    expect(within(panel).getByText(copy)).toBeTruthy();
  }
  fireEvent.change(within(panel).getByLabelText(/Contact's email or phone/), { target: { value: ' Tunde@Example.com ' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Create vouch' }));
  expect(await within(panel).findByDisplayValue(`${window.location.origin}/invite/VCHR2345EFGH`)).toBeTruthy();
  expect(within(panel).getByText('VCHR-2345-EFGH')).toBeTruthy();
  expect(within(panel).getByText(/Only tunde@example.com can claim/)).toBeTruthy();
  const [, options] = fetch.mock.calls.find(([url]) => String(url).endsWith('/invites'))!;
  expect(JSON.parse(options.body)).toEqual({ rail: 'vouch', recipientContact: 'Tunde@Example.com', platform: 'web', journeyId });
  // The public link panel keeps its own state.
  expect(within(screen.getByRole('group', { name: 'Public share link' })).queryByDisplayValue(/VCHR2345EFGH/)).toBeNull();
});

test('a missing contact is explained before any request, and server rejections keep the entered contact', async () => {
  const fetch = setup(async () => new Response(JSON.stringify({ error: { code: 'SELF_INVITE', message: 'You cannot vouch for your own contact.', retryable: false }, requestId: 'ui-test' }), { status: 400 }));
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
  const panel = await screen.findByRole('group', { name: 'Vouch for a contact' });
  expect(within(panel).getByText(/No seats remain/)).toBeTruthy();
  expect(within(panel).getByRole('button', { name: 'Create vouch' }).hasAttribute('disabled')).toBe(true);
});
