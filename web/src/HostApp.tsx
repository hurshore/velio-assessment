import { ErrorNotice } from './ErrorNotice';
import { usePath, followRoute } from './navigation';
import { ViewDelivery } from './view-delivery';
import { ViewDeliveryStatus } from './ViewDeliveryStatus';
import { ActivityBrowser } from './ActivityBrowser';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, journey, message, parseIdentity, parseList, persist, stored, type Identity } from './api';

export function HostApp() {
  const path = usePath();
  const [identityOpen, setIdentityOpen] = useState(false);
  const identitySelect = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (identityOpen) identitySelect.current?.focus(); }, [identityOpen]);
  const [delivery] = useState(() => new ViewDelivery());
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
    const fields = new FormData(form);
    const displayName = String(fields.get('displayName') ?? '').trim();
    const contact = String(fields.get('contact') ?? '').trim();
    if (!displayName || displayName.length > 100) { setError('Display name must contain 1–100 characters.'); return; }
    setCreating(true); setError('');
    try {
      const user = parseIdentity(await api('/identities', { body: { displayName, journeyId, platform: 'web', ...(contact ? { contact } : {}) } }));
      setIdentities(previous => [...previous, user]); select(user.id); form.reset();
    } catch (error) { setError(message(error)); }
    finally { setCreating(false); }
  }
  const actor = identities.find(user => user.id === actorId);
  return <>
    <header className="app-header"><a href="/" className="brand" onClick={event => followRoute(event, '/')}>velio<span>●</span></a>
      <nav aria-label="Main navigation"><a aria-current={path === '/' ? 'page' : undefined} href="/" onClick={event => followRoute(event, '/')}>Explore</a><a aria-current={path === '/hosting' ? 'page' : undefined} href="/hosting" onClick={event => followRoute(event, '/hosting')}>Hosting</a></nav>
      <button aria-expanded={identityOpen} aria-controls="identity-panel" className="secondary identity-toggle" onClick={() => setIdentityOpen(value => !value)}>Using demo as {actor?.displayName ?? 'Visitor'}</button>
    </header>
    <div id="identity-panel" hidden={!identityOpen} className="identity-panel"><button className="secondary" onClick={() => setIdentityOpen(false)}>Done choosing identity</button>
    <section aria-labelledby="identity-heading">
      <h2 id="identity-heading">Choose a demo identity</h2>
      <p>Demo identities are not verified authentication. Anyone using this demo can select them.</p>
      {loading ? <p role="status">Loading identities…</p> : null}
      {error ? <><ErrorNotice text={error} /><button onClick={() => setAttempt(value => value + 1)}>Retry identities</button></> : null}
      {!loading && !identities.length ? <p>No demo identities yet. Create one to host an activity.</p> : null}
      <label>Demo identity<select ref={identitySelect} value={identities.some(user => user.id === actorId) ? actorId : ''} disabled={loading || creating || hosting} onChange={event => select(event.target.value)}>
        <option value="">Browse without an identity</option>
        {identities.map(user => <option value={user.id} key={user.id}>{user.displayName}</option>)}
      </select></label>
      <form onSubmit={createIdentity}>
        <label>Display name<input name="displayName" required maxLength={100} autoComplete="nickname" /></label>
        <label>Contact for vouches (optional email or phone)<input name="contact" maxLength={254} autoComplete="off" /></label>
        <p className="hint">A vouch can be claimed only by the identity whose contact matches it. Matching ignores letter case, spaces and punctuation but nothing else, so use the same format the inviter will enter (for example, with or without a country code). This contact is not verified, is set once and is never shown to other people.</p>
        <button disabled={creating || loading || hosting}>{creating ? 'Creating identity…' : 'Create demo identity'}</button>
      </form>
    </section>
    </div>
    <ActivityBrowser delivery={delivery} journeyId={journeyId} actorId={identities.some(user => user.id === actorId) ? actorId : ''} setHosting={setHosting} requestIdentity={() => setIdentityOpen(true)} />
    <details className="diagnostics"><summary>Demo guidance &amp; tracking</summary><p>Demo identities and contacts are unverified. Prices describe the commitment; no payment is collected.</p></details><ViewDeliveryStatus delivery={delivery} />
  </>;
}
