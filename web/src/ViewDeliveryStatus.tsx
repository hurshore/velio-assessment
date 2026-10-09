import { useSyncExternalStore, type ReactNode } from 'react';
import type { ViewDelivery } from './view-delivery';

export function ViewDeliveryStatus({ delivery, children, label = 'Reviewer diagnostics' }: { delivery: ViewDelivery; children?: ReactNode; label?: string }) {
  const entries = useSyncExternalStore(delivery.subscribe, delivery.getSnapshot, delivery.getSnapshot);
  if (!entries.length && !children) return null;
  const pending = entries.filter(entry => entry.status === 'sending').length;
  const needsAttention = entries.some(entry => entry.status === 'failed' || entry.status === 'rejected');
  return <details className="diagnostics"><summary>{label}<span role="status" aria-live="polite">{needsAttention ? ' · Tracking needs attention' : ''}</span></summary>
    {children}
    {entries.length ? <section aria-label="View tracking delivery" aria-live="polite">
    <h2>View tracking</h2>
    {pending ? <p role="status">Saving {pending} rendered view {pending === 1 ? 'event' : 'events'}…</p> : null}
    {entries.filter(entry => entry.status === 'failed').map(entry => <div key={entry.event.id}>
      <p role="alert">View tracking could not be saved for {entry.title}: {entry.error}</p>
      <p className="hint">Retry saves the original view, even if you have changed identities or activities.</p>
      <button onClick={() => delivery.retry(entry.event.id)}>Retry view tracking</button>
    </div>)}
    {entries.filter(entry => entry.status === 'rejected').map(entry => <div key={entry.event.id}>
      <p role="alert">View tracking could not be saved for {entry.title}: {entry.error}</p>
      <p className="hint">The server rejected this event, so retrying would not help.</p>
    </div>)}
  </section> : null}
  </details>;
}
