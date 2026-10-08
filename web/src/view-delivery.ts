import { api, ApiError, message, type PolicyReason, type PreviewState } from './api';
import { isRecord, unexpectedResponseMessage } from './response-envelope';

export interface RenderedViewEvent {
  readonly id: string; readonly schemaVersion: 1; readonly name: 'activity_viewed'; readonly source: 'client'; readonly platform: 'web';
  readonly occurredAt: string; readonly actorId?: string; readonly journeyId: string; readonly activityId: string; readonly planId: string;
}
export interface RenderedExposureEvent extends Omit<RenderedViewEvent, 'name'> {
  readonly name: 'experiment_exposed';
  readonly displayedInviteState: { readonly enabled: boolean; readonly creationEnabled: boolean; readonly reason: PolicyReason };
}
// Sent only after a human-visible preview renders; resolving a link alone never records an open.
export interface RenderedInviteOpenEvent {
  readonly id: string; readonly schemaVersion: 1; readonly name: 'invite_opened'; readonly source: 'client'; readonly platform: 'web';
  readonly occurredAt: string; readonly actorId?: string; readonly journeyId: string; readonly inviteCode: string; readonly displayedState: PreviewState;
}
type RenderedEvent = RenderedViewEvent | RenderedExposureEvent | RenderedInviteOpenEvent;
interface Delivery {
  readonly event: RenderedEvent;
  readonly title: string;
  // 'rejected' is a definitive, non-retryable server refusal; it stays visible but is never resent.
  readonly status: 'sending' | 'failed' | 'rejected';
  readonly error?: string;
}
// Owned by the host application, so local navigation cannot cancel a captured view or erase its failure.
// This is an in-memory delivery registry; refresh/closure is best effort, without an offline queue.
export class ViewDelivery {
  private exposures = new Map<string, string>();
  private entries = new Map<string, Delivery>();
  private listeners = new Set<() => void>();
  private snapshot: readonly Delivery[] = [];
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  // Keep the last displayed state per identity/activity for this app session.
  // A state change creates a new observation; retries preserve the frozen original.
  captureExposure(event: RenderedExposureEvent, title: string, signature: string) {
    const key = JSON.stringify([event.activityId, event.actorId ? 'actor' : 'journey', event.actorId ?? event.journeyId]);
    if (this.exposures.get(key) === signature) return;
    this.exposures.set(key, signature);
    this.capture({ ...event, displayedInviteState: Object.freeze({ ...event.displayedInviteState }) }, title);
  }
  capture(event: RenderedEvent, title: string) {
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
      const rejected = error instanceof ApiError && !error.retryable;
      this.entries.set(event.id, { ...delivery, status: rejected ? 'rejected' : 'failed', error: message(error) });
    }
    this.publish();
  }
  private publish() {
    this.snapshot = [...this.entries.values()];
    this.listeners.forEach(listener => listener());
  }
}
