import { ActivityBrowser } from './ActivityBrowser';
import { useEffect, useState, type FormEvent } from 'react';
import { api, journey, message, parseIdentity, parseList, persist, stored, type Identity } from './api';

export function HostApp() {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [actorId, setActorId] = useState(() => stored('velio.actor.v1'));
  const [journeyId] = useState(journey);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hosting, setHosting] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void api('/identities', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setIdentities(parseList(data, parseIdentity));
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  function select(id: string) {
    setActorId(id);
    if (!persist('velio.actor.v1', id)) setError('Browser storage is unavailable; this identity selection will not survive reload.');
  }
  async function createIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const displayName = String(new FormData(form).get('displayName') ?? '').trim();
    if (!displayName || displayName.length > 100) { setError('Display name must contain 1–100 characters.'); return; }
    setCreating(true); setError('');
    try {
      const user = parseIdentity(await api('/identities', { body: { displayName, journeyId, platform: 'web' } }));
      setIdentities(previous => [...previous, user]); select(user.id); form.reset();
    } catch (error) { setError(message(error)); }
    finally { setCreating(false); }
  }
  return <>
    <section aria-labelledby="identity-heading">
      <h2 id="identity-heading">Choose a demo identity</h2>
      <p>Demo identities are not verified authentication. Anyone using this demo can select them.</p>
      {loading ? <p role="status">Loading identities…</p> : null}
      {error ? <><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry identities</button></> : null}
      {!loading && !identities.length ? <p>No demo identities yet. Create one to host an activity.</p> : null}
      <label>Demo identity<select value={identities.some(user => user.id === actorId) ? actorId : ''} disabled={loading || creating || hosting} onChange={event => select(event.target.value)}>
        <option value="">Browse without an identity</option>
        {identities.map(user => <option value={user.id} key={user.id}>{user.displayName}</option>)}
      </select></label>
      <form onSubmit={createIdentity}>
        <label>Display name<input name="displayName" required maxLength={100} autoComplete="nickname" /></label>
        <button disabled={creating || loading || hosting}>{creating ? 'Creating identity…' : 'Create demo identity'}</button>
      </form>
    </section>
    <ActivityBrowser journeyId={journeyId} actorId={identities.some(user => user.id === actorId) ? actorId : ''} setHosting={setHosting} />
  </>;
}
