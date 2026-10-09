import { HostApp } from './HostApp';
import { GuestInvite } from './GuestInvite';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { parseReadiness, connectionErrorMessage, unexpectedResponseMessage, type Readiness } from './readiness';

type Connection = { status: 'loading' } | Readiness;
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

// Guests arrive on /invite/<code> from a shared link; everything else is the host/booker app.
// Returns null outside the invite route, or the (possibly empty) code inside it.
function inviteCodeFromPath(path: string): string | null {
  const match = path.match(/^\/invite(?:\/([^/]*))?\/?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1] ?? ''); } catch { return match[1] ?? ''; }
}
function subscribeToHistory(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
const currentPath = () => window.location.pathname;

export function App() {
  const guestCode = inviteCodeFromPath(useSyncExternalStore(subscribeToHistory, currentPath));
  if (guestCode !== null) return <main className="guest">
    <a className="brand" href="/">velio<span>.</span></a><p className="eyebrow">YOU’RE INVITED</p>
    <GuestInvite code={guestCode} />
  </main>;
  return <HostAndBooker />;
}

function HostAndBooker() {
  const [connection, setConnection] = useState<Connection>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let active = true;
    setConnection({ status: 'loading' });
    void fetch(`${apiBase}/api/ready`, { signal: controller.signal })
      .then(async response => {
        let readiness: Readiness;
        try { readiness = parseReadiness(response.status, await response.json()); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          if (active) {
            console.warn('API readiness response rejected:', error);
            setConnection({ status: 'error', message: unexpectedResponseMessage });
          }
          return;
        }
        if (active) setConnection(readiness);
      })
      .catch(() => { if (active) setConnection({ status: 'error', message: connectionErrorMessage }); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [attempt]);
  return <main>

    {connection.status === 'ready' ? <HostApp /> : null}
    <details className="diagnostics" open={connection.status !== 'ready'}><summary>Reviewer diagnostics</summary><section aria-live="polite" aria-label="API connection">
      {connection.status === 'loading' ? <p>Checking API connection…</p> : connection.status === 'error' ? <>
        <h2>Connection unavailable</h2>
        <p>{connection.message}</p>
        {connection.requestId ? <small>Request: {connection.requestId}</small> : null}
        <button onClick={() => setAttempt(value => value + 1)}>Retry connection</button>
      </> : <>
        <h2>API connected</h2>
        <p>PostgreSQL and Redis are ready.</p>
        <small>Request: {connection.requestId}</small>
      </>}
    </section><a href={`${apiBase}/api/metrics`}>Open metrics</a></details>
  </main>;
}
