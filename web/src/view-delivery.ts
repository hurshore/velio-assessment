import { api, message } from './api';
import { isRecord, unexpectedResponseMessage } from './response-envelope';

export interface RenderedViewEvent {
  readonly id: string; readonly schemaVersion: 1; readonly name: 'activity_viewed' | 'experiment_exposed'; readonly source: 'client'; readonly platform: 'web';
  readonly occurredAt: string; readonly actorId?: string; readonly journeyId: string; readonly activityId: string; readonly planId: string;
}
interface Delivery {
  readonly event: RenderedViewEvent;
  readonly title: string;
  readonly status: 'sending' | 'failed';
  readonly error?: string;
}
// Owned by the host application, so local navigation cannot cancel a captured view or erase its failure.
// This is an in-memory delivery registry; refresh/closure is best effort, without an offline queue.
export class ViewDelivery {
  private entries = new Map<string, Delivery>();
  private listeners = new Set<() => void>();
  private snapshot: readonly Delivery[] = [];
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  capture(event: RenderedViewEvent, title: string) {
    if (this.entries.has(event.id)) return;
    const delivery: Delivery = { event: Object.freeze({ ...event }), title, status: 'sending' };
    this.entries.set(event.id, delivery);
    this.publish();
    void this.send(delivery);
  }
  retry(id: string) {
    const previous = this.entries.get(id);
    if (!previous || previous.status !== 'failed') return;
    const delivery: Delivery = { event: previous.event, title: previous.title, status: 'sending' };
    this.entries.set(id, delivery);
    this.publish();
    void this.send(delivery);
  }
  private async send(delivery: Delivery) {
    const { event } = delivery;
    try {
      // api bounds each attempt to eight seconds; the actor header belongs to the captured event.
      const receipt = await api('/events', { body: event, actorId: event.actorId });
      if (!isRecord(receipt) || receipt.id !== event.id || typeof receipt.accepted !== 'boolean') throw new Error(unexpectedResponseMessage);
      this.entries.delete(event.id);
    } catch (error) {
      this.entries.set(event.id, { ...delivery, status: 'failed', error: message(error) });
    }
    this.publish();
  }
  private publish() {
    this.snapshot = [...this.entries.values()];
    this.listeners.forEach(listener => listener());
  }
}
