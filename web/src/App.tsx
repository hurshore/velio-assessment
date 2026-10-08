import { useEffect, useState } from 'react';

type Connection = { status: 'loading' } | { status: 'ready'; requestId: string } | { status: 'error'; message: string; requestId?: string };
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export function App() {
  const [connection, setConnection] = useState<Connection>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Connection timed out')), 5000);
    let active = true;
    setConnection({ status: 'loading' });
    void fetch(`${apiBase}/api/ready`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!active) return;
        if (!response.ok) {
          setConnection({ status: 'error', message: body.error?.code === 'DEPENDENCIES_UNAVAILABLE'
            ? 'The API is running, but its dependencies are unavailable. Please retry.'
            : 'Could not connect to the API. Check your connection and retry.', requestId: body.requestId });
          return;
        }
        if (body.data?.status !== 'ok' || body.data?.dependencies?.postgres !== 'ok' || body.data?.dependencies?.redis !== 'ok' || typeof body.requestId !== 'string') {
          throw new Error('Unexpected readiness response');
        }
        setConnection({ status: 'ready', requestId: body.requestId });
      })
      .catch(() => { if (active) setConnection({ status: 'error', message: 'Could not connect to the API. Check your connection and retry.' }); })
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
