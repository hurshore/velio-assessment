import { useSyncExternalStore } from 'react';
import type { ViewDelivery } from './view-delivery';

export function ViewDeliveryStatus({ delivery }: { delivery: ViewDelivery }) {
  const entries = useSyncExternalStore(delivery.subscribe, delivery.getSnapshot, delivery.getSnapshot);
  if (!entries.length) return null;
  const pending = entries.filter(entry => entry.status === 'sending').length;
  return <section aria-label="View tracking delivery" aria-live="polite">
    <h2>View tracking</h2>
    {pending ? <p role="status">Saving {pending} rendered view {pending === 1 ? 'event' : 'events'}…</p> : null}
    {entries.filter(entry => entry.status === 'failed').map(entry => <div key={entry.event.id}>
      <p role="alert">View tracking could not be saved for {entry.title}: {entry.error}</p>
      <p className="hint">Retry saves the original view, even if you have changed identities or activities.</p>
      <button onClick={() => delivery.retry(entry.event.id)}>Retry view tracking</button>
    </div>)}
  </section>;
}
