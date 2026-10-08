// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

const preview = { code: 'ABCD2345EFGH', rail: 'public', trust: 'public', state: 'valid', createdAt: '2026-10-08T12:00:00.000Z', expiresAt: '2026-10-09T12:00:00.000Z',
  inviter: { displayName: 'Amara', role: 'host' },
  activity: { id: '22222222-2222-4222-8222-222222222222', planId: '33333333-3333-4333-8333-333333333333', title: 'Supper club', description: 'Shared plates.',
    meetingLocation: 'Courtyard, Lagos', startsAt: '2030-03-01T18:00:00.000Z', timezone: 'Africa/Lagos', status: 'scheduled', capacity: 6, confirmedCount: 2,
    remainingSeats: 4, priceMinor: 500000, currency: 'NGN', version: 3 } };
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, requestId: 'ui-test' }), { status });
const invalid = () => new Response(JSON.stringify({ error: { code: 'INVALID_INVITE', message: 'This invitation code is not valid. Check the code and try again.', retryable: false }, requestId: 'ui-test' }), { status: 404 });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

function visit(path: string, resolve: (code: string) => Promise<Response>) {
  window.history.replaceState(null, '', path);
  const events: Record<string, unknown>[] = [];
  const fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) {
      const event = JSON.parse(options.body as string);
      events.push(event);
      return Promise.resolve(ok({ id: event.id, accepted: true }, 202));
    }
    const match = url.match(/\/invites\/([^/]+)$/);
    if (match) return resolve(decodeURIComponent(match[1]!));
    return Promise.reject(new Error(`Unexpected request ${url}`));
  });
  vi.stubGlobal('fetch', fetch);
  render(<StrictMode><App /></StrictMode>);
  return { events, fetch };
}

test('a guest previews activity and inviter context, with the code and app-opening path, before any identity', async () => {
  const { events, fetch } = visit('/invite/ABCD2345EFGH', async () => ok(preview));
  expect(await screen.findByRole('heading', { name: 'Supper club' })).toBeTruthy();
  expect(screen.getByText(/Amara invited you/)).toBeTruthy();
  expect(screen.getByText(/public link/i)).toBeTruthy();
  expect(screen.getByText('Courtyard, Lagos')).toBeTruthy();
  expect(screen.getByText(/Africa\/Lagos/)).toBeTruthy();
  expect(screen.getByText(/4 of 6 seats open/)).toBeTruthy();
  expect(screen.getByText(/5,000/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open in the Velio app' }).getAttribute('href')).toMatch(/^velio:\/\/invite\/ABCD2345EFGH\?journey=/);
  expect(screen.getByText('ABCD-2345-EFGH')).toBeTruthy();
  expect(screen.queryByText(/API connected/)).toBeNull();
  await waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]).toMatchObject({ name: 'invite_opened', schemaVersion: 1, source: 'client', platform: 'web', inviteCode: 'ABCD2345EFGH', displayedState: 'valid' });
  expect(events[0]!.journeyId).toBe(localStorage.getItem('velio.journey.v1'));
  expect(events[0]!.actorId).toBeUndefined();
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/invites/')).every(([, options]) => !options?.body)).toBe(true);
});

for (const [state, copy] of [['full', /The last spot has been taken/], ['expired', /This invitation has expired/],
  ['started', /This activity has already started/], ['cancelled', /This activity was cancelled/]] as const) {
  test(`a ${state} invitation keeps its context visible, records the open and does not encourage claiming`, async () => {
    const { events } = visit('/invite/ABCD2345EFGH', async () => ok({ ...preview, state, activity: { ...preview.activity, ...(state === 'full' ? { confirmedCount: 6, remainingSeats: 0 } : {}), ...(state === 'cancelled' ? { status: 'cancelled' } : {}) } }));
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Supper club' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open in the Velio app' })).toBeNull();
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.displayedState).toBe(state);
  });
}

test('an invalid code is explained, preserved for editing, and a corrected code loads without a reload', async () => {
  const { events } = visit('/invite/ZZZZZZZZZZZZ', async code => code === 'ABCD2345EFGH' ? ok(preview) : invalid());
  expect(await screen.findByText(/This invitation code is not valid/)).toBeTruthy();
  const input = screen.getByLabelText('Invitation code') as HTMLInputElement;
  expect(input.value).toBe('ZZZZZZZZZZZZ');
  fireEvent.change(input, { target: { value: 'abcd-2345 efgh' } });
  fireEvent.click(screen.getByRole('button', { name: 'View invitation' }));
  expect(await screen.findByRole('heading', { name: 'Supper club' })).toBeTruthy();
  expect(window.location.pathname).toBe('/invite/ABCD2345EFGH');
  await waitFor(() => expect(events).toHaveLength(1));
});

test('code entry rejects a malformed code locally and a connection failure offers retry with the code kept', async () => {
  let attempts = 0;
  visit('/invite', async () => { attempts += 1; if (attempts === 1) throw new TypeError('Network down'); return ok(preview); });
  const input = await screen.findByLabelText('Invitation code');
  fireEvent.change(input, { target: { value: 'short' } });
  fireEvent.click(screen.getByRole('button', { name: 'View invitation' }));
  expect(await screen.findByText(/Codes have 12 letters and numbers/)).toBeTruthy();
  expect(attempts).toBe(0);
  fireEvent.change(input, { target: { value: 'ABCD2345EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: 'View invitation' }));
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  expect((screen.getByLabelText('Invitation code') as HTMLInputElement).value).toBe('ABCD2345EFGH');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'Supper club' })).toBeTruthy();
});

test('the app-opening link carries the persistent journey so an app claim can join this open', async () => {
  visit('/invite/ABCD2345EFGH', async () => ok(preview));
  const link = await screen.findByRole('link', { name: 'Open in the Velio app' });
  expect(link.getAttribute('href')).toBe(`velio://invite/ABCD2345EFGH?journey=${localStorage.getItem('velio.journey.v1')}`);
});

test('browser Back and Forward keep the guest page in step with the URL, and navigation moves focus to the result', async () => {
  visit('/invite/ZZZZZZZZZZZZ', async code => code === 'ABCD2345EFGH' ? ok(preview) : invalid());
  await screen.findByText(/This invitation code is not valid/);
  expect(document.activeElement).toBe(document.body);
  fireEvent.change(screen.getByLabelText('Invitation code'), { target: { value: 'ABCD2345EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: 'View invitation' }));
  const heading = await screen.findByRole('heading', { name: 'Supper club' });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  window.history.back();
  expect(await screen.findByText(/This invitation code is not valid/)).toBeTruthy();
  expect(window.location.pathname).toBe('/invite/ZZZZZZZZZZZZ');
  expect((screen.getByLabelText('Invitation code') as HTMLInputElement).value).toBe('ZZZZZZZZZZZZ');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Invitation not found' })));
  window.history.forward();
  expect(await screen.findByRole('heading', { name: 'Supper club' })).toBeTruthy();
  expect(window.location.pathname).toBe('/invite/ABCD2345EFGH');
});

test('a non-retryable open rejection is reported without offering a retry that cannot succeed', async () => {
  window.history.replaceState(null, '', '/invite/ABCD2345EFGH');
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => url.endsWith('/events')
    ? Promise.resolve(invalid())
    : Promise.resolve(ok(preview))));
  render(<App />);
  expect(await screen.findByText(/could not be saved for Supper club invitation/)).toBeTruthy();
  expect(screen.getByText(/This invitation code is not valid/, { selector: '[role=alert]' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry view tracking' })).toBeNull();
});

test('a preview missing contract fields is rejected rather than rendered from a partial response', async () => {
  for (const broken of [{ ...preview, createdAt: undefined }, { ...preview, activity: { ...preview.activity, planId: undefined } },
    { ...preview, inviter: { displayName: '', role: 'host' } }, { ...preview, activity: { ...preview.activity, remainingSeats: 9 } }]) {
    cleanup();
    visit('/invite/ABCD2345EFGH', async () => ok(broken));
    expect(await screen.findByText(/unexpected/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Supper club' })).toBeNull();
  }
});

test('loading progress is announced through a status region that stays mounted', async () => {
  let finish!: (response: Response) => void;
  visit('/invite/ABCD2345EFGH', () => new Promise<Response>(resolve => { finish = resolve; }));
  const region = screen.getByText('Loading your invitation…');
  finish(ok(preview));
  await screen.findByRole('heading', { name: 'Supper club' });
  expect(region.isConnected).toBe(true);
  expect(region.textContent).toBe('');
});
