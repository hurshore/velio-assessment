import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('shows API readiness and request reference after a successful roundtrip', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data: { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } }, requestId: 'web-roundtrip',
  }), { status: 200 })));
  render(<App />);
  expect(screen.getByText('Checking API connection…')).toBeTruthy();
  expect(await screen.findByText('API connected')).toBeTruthy();
  expect(screen.getByText('PostgreSQL and Redis are ready.')).toBeTruthy();
  expect(screen.getByText('Request: web-roundtrip')).toBeTruthy();
});

test('offers a useful connection error and retry after network failure', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } }, requestId: 'retry-success' }), { status: 200 })));
  render(<App />);
  expect(await screen.findByText('Could not connect to the API. Check your connection and retry.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
  expect(await screen.findByText('API connected')).toBeTruthy();
});

test('does not claim readiness when the API returns a dependency outage', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { code: 'DEPENDENCIES_UNAVAILABLE', message: 'Service dependencies are unavailable. Please retry.', retryable: true }, requestId: 'outage-reference',
  }), { status: 503 })));
  render(<App />);
  expect(await screen.findByText('The API is running, but its dependencies are unavailable. Please retry.')).toBeTruthy();
  expect(screen.queryByText('API connected')).toBeNull();
  expect(screen.getByText('Request: outage-reference')).toBeTruthy();
});
