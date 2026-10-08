// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityDetails } from './ActivityDetails';
import { ViewDelivery } from './view-delivery';
import { ViewDeliveryStatus } from './ViewDeliveryStatus';

const activity = { id: '22222222-2222-4222-8222-222222222222', hostId: '11111111-1111-4111-8111-111111111111', title: 'Cohort walk', description: 'A gentle walk.', meetingLocation: 'Marina gate',
  startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity: 4, confirmedCount: 0, remainingSeats: 4,
  priceMinor: 0, currency: 'NGN', version: 1, status: 'scheduled', planId: '33333333-3333-4333-8333-333333333333', participants: [],
  assignment: { experiment: 'group_invites_v1', version: '1', treatmentPercent: 50, variant: 'treatment', assignedAt: '2026-10-08T12:00:00Z' }, inviteCreationEnabled: true };
const response = (data: unknown) => new Response(JSON.stringify({ data, requestId: 'test' }), { status: 200 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
for (const [variant, enabled, copy] of [
  ['treatment', true, 'This activity is assigned to the invitation experience.'],
  ['control', true, 'This activity supports ordinary booking. New invitations are unavailable.'],
  ['treatment', false, 'New invitations are temporarily unavailable. You can still book a seat.'],
] as const) {
  test(`renders ${variant} with creation ${enabled} before emitting deduplicated exposure`, async () => {
    const events: { id: string; name: string }[] = [];
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (url.endsWith('/events')) {
        const event = JSON.parse(options.body as string);
        events.push(event);
        return Promise.resolve(response({ id: event.id, accepted: true }));
      }
      return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const delivery = new ViewDelivery();
    render(<StrictMode><ActivityDetails id={activity.id} actorId="" journeyId="44444444-4444-4444-8444-444444444444" close={() => {}} delivery={delivery} /></StrictMode>);
    expect(screen.queryByRole('region', { name: 'Invitation experience' })).toBeNull();
    expect(events).toHaveLength(0);
    finish(response({ ...activity, assignment: { ...activity.assignment, variant }, inviteCreationEnabled: enabled }));
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.getByText('Select a demo identity to book one seat.')).toBeTruthy();
    await waitFor(() => expect(events.filter(event => event.name === 'experiment_exposed')).toHaveLength(1));
    expect(events.filter(event => event.name === 'activity_viewed')).toHaveLength(1);
  });
}

test('failed exposure delivery preserves the shown activity and retries the original event', async () => {
  const events: Record<string, unknown>[] = [];
  let failed = false;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) {
      const event = JSON.parse(options.body as string);
      events.push(event);
      if (event.name === 'experiment_exposed' && !failed) { failed = true; return Promise.reject(new Error('Exposure unavailable')); }
      return Promise.resolve(response({ id: event.id, accepted: true }));
    }
    return Promise.resolve(response(activity));
  }));
  const delivery = new ViewDelivery();
  render(<><ActivityDetails id={activity.id} actorId="" journeyId="44444444-4444-4444-8444-444444444444" close={() => {}} delivery={delivery} /><ViewDeliveryStatus delivery={delivery} /></>);
  await screen.findByText(/Exposure unavailable/);
  expect(screen.getByText('This activity is assigned to the invitation experience.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry view tracking' }));
  await waitFor(() => expect(events.filter(event => event.name === 'experiment_exposed')).toHaveLength(2));
  const exposures = events.filter(event => event.name === 'experiment_exposed');
  expect(exposures[1]).toEqual(exposures[0]);
});
