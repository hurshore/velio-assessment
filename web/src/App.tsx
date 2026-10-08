import { useEffect, useState } from 'react';

import { parseReadiness, connectionErrorMessage, unexpectedResponseMessage, type Readiness } from './readiness';

type Connection = { status: 'loading' } | Readiness;
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export function App() {
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
    <p className="eyebrow">VELIO / FOUNDATION</p>
    <h1>Plans start with a connection.</h1>
    <p>Check the shared API connection before exploring activities.</p>
    <section aria-live="polite" aria-label="API connection">
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
    </section>
  </main>;
}
