import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { activityDetail } from './activities.js';
import { rows, uuid, type Database } from './domain.js';
import { reportFailure, type FailureReporter } from './diagnostics.js';
import type { AvailabilityEvent } from './outbox.js';
import { recoverDelivery, saveAck, saveObservation, type DeliveryClock, type Observation, type Timing } from './live-store.js';

interface Delivery extends DeliveryClock { saved: Promise<void> }
interface Subscriber {
  socket: WebSocket; connectionId: string; clientId: string; activityId: string; foreground: boolean;
  initialVersion?: number; ready: boolean; buffered: AvailabilityEvent[]; deliveries: Map<string, Delivery>; running: Promise<void>;
}
interface PendingObservation extends Observation { subscribers: Subscriber[]; saving: boolean }
export function attachLive(server: Server, db: Database, origin: string, options: { processId?: string; reconcileMs?: number; log?: FailureReporter } = {}) {
  const processId = options.processId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const log = options.log ?? reportFailure;
  const sockets = new Set<WebSocket>();
  const subscribers = new Set<Subscriber>();
  const observations = new Map<string, PendingObservation>();
  let measurementFailures = 0;
  let registration: Promise<void> | undefined;
  let stopped = false;
  const work = new Set<Promise<unknown>>();
  function track<T>(promise: Promise<T>) {
    work.add(promise);
    void promise.finally(() => work.delete(promise)).catch(() => {});
    return promise;
  }
  async function register() {
    registration ??= db.query('INSERT INTO live_processes (process_id,started_at) VALUES ($1,$2) ON CONFLICT DO NOTHING', [processId, startedAt]).then(() => {});
    try { await registration; } catch (error) { registration = undefined; throw error; }
  }
  function failed(error: unknown) { measurementFailures++; log({ component: 'live.delivery' }, error); }
  void track(register()).catch(failed);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/live' || (request.headers.origin && request.headers.origin !== origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  function send(sub: Subscriber, payload: object) {
    if (sub.socket.readyState !== WebSocket.OPEN) return;
    if (sub.socket.bufferedAmount > 256_000) { sub.socket.close(1013, 'Client is too slow'); return; }
    sub.socket.send(JSON.stringify(payload));
  }
  async function snapshot(sub: Subscriber, event?: AvailabilityEvent) {
    const activity = await activityDetail(db, sub.activityId);
    sub.initialVersion ??= Number(activity.version);
    if (event) {
      const delivery = sub.deliveries.get(event.eventId);
      if (delivery?.sentVersion !== Number(activity.version)) {
        await db.query(`UPDATE live_deliveries SET sent_version=GREATEST(COALESCE(sent_version,0),$4)
          WHERE event_id=$1 AND process_id=$2 AND connection_id=$3`, [event.eventId, processId, sub.connectionId, activity.version]);
        if (delivery) delivery.sentVersion = Number(activity.version);
      }
    }
    send(sub, { type: 'snapshot', eventId: event?.eventId ?? null, activityId: sub.activityId,
      version: activity.version, capacity: activity.capacity, confirmedCount: activity.confirmedCount,
      remainingSeats: activity.remainingSeats, activity });
  }
  function enqueue(sub: Subscriber, operation: () => Promise<void>) {
    sub.running = track(sub.running.then(() => sub.socket.readyState === WebSocket.OPEN ? operation() : undefined).catch(error => {
      log({ component: 'live.snapshot' }, error);
      send(sub, { type: 'unavailable', message: 'Live details are unavailable. Refresh or reconnect.' });
    }));
  }
  function persist(observation: PendingObservation) {
    observation.saving = true;
    const saved = track(register().then(() => saveObservation(db, processId, observation)));
    void saved.then(() => observations.delete(observation.event.eventId)).catch(failed).finally(() => { observation.saving = false; });
    for (const sub of observation.subscribers) {
      sub.deliveries.set(observation.event.eventId, { event: observation.event, timing: observation.timing, started: observation.started, saved });
      if (!sub.ready) {
        if (!sub.buffered.some(event => event.eventId === observation.event.eventId)) sub.buffered.push(observation.event);
      } else enqueue(sub, async () => { await saved; await snapshot(sub, observation.event); });
      if (sub.buffered.length > 256 || sub.deliveries.size > 256) sub.socket.close(1013, 'Too many unacknowledged updates');
    }
  }
  function observe(event: AvailabilityEvent, timing: Timing, started: number) {
    if (observations.has(event.eventId)) return;
    // Failed writes retain their original cohort and clock; the outbox/process ledger exposes any gap.
    if (observations.size >= 512) { failed(new Error('Live observation retry queue is full')); return; }
    const relevant = [...subscribers].filter(s => s.activityId === event.activityId && s.foreground &&
      (timing === 'commit_observed' || s.initialVersion === undefined || event.version > s.initialVersion));
    const observation: PendingObservation = { event, timing, started, observedAt: new Date().toISOString(), subscribers: relevant, saving: false };
    observations.set(event.eventId, observation);
    persist(observation);
  }
  // Called synchronously immediately after COMMIT returns, before unrelated telemetry awaits.
  function committed(event: AvailabilityEvent) { observe(event, 'commit_observed', performance.now()); }
  async function published(message: string) {
    const value = JSON.parse(message) as AvailabilityEvent;
    uuid(value.eventId, 'Event'); uuid(value.activityId, 'Activity');
    const [event] = await rows<{ payload: AvailabilityEvent; createdAt: Date; bookingId: string }>(db,
      'SELECT payload,created_at AS "createdAt",booking_id AS "bookingId" FROM outbox_events WHERE id=$1', [value.eventId]);
    if (!event) return;
    const [existing] = await rows(db, 'SELECT 1 FROM live_observations WHERE event_id=$1 AND process_id=$2', [value.eventId, processId]);
    if (!existing) observe({ ...event.payload, bookingId: event.bookingId, createdAt: event.createdAt.toISOString() }, 'pre_commit_proxy', performance.now());
  }
  wss.on('connection', socket => {
    sockets.add(socket);
    let sub: Subscriber | undefined;
    let messageQueue = Promise.resolve();
    const handshake = setTimeout(() => { if (!sub) socket.close(1008, 'Subscription required'); }, 5000);
    socket.on('error', error => log({ component: 'live.socket' }, error));
    socket.on('close', () => { clearTimeout(handshake); sockets.delete(socket); if (sub) subscribers.delete(sub); });
    socket.on('message', data => {
      const receivedClock = performance.now();
      const receivedAt = Date.now();
      messageQueue = track(messageQueue.then(async () => {
        const message = JSON.parse(data.toString());
        if (socket.readyState !== WebSocket.OPEN) return;
        if (message.type === 'subscribe' && !sub) {
          await register();
          sub = { socket, connectionId: randomUUID(), clientId: uuid(message.clientId, 'Client'),
            activityId: uuid(message.activityId, 'Activity').toLowerCase(), foreground: message.foreground === true,
            ready: false, buffered: [], deliveries: new Map(), running: Promise.resolve() };
          subscribers.add(sub); clearTimeout(handshake);
          // Register/buffer before reading; the initial version defines subsequent committed updates.
          const current = sub;
          enqueue(current, async () => {
            await snapshot(current);
            current.ready = true;
            for (const event of current.buffered.splice(0)) {
              await current.deliveries.get(event.eventId)!.saved;
              await snapshot(current, event);
            }
          });
        } else if (message.type === 'foreground' && sub && typeof message.foreground === 'boolean') {
          sub.foreground = message.foreground;
          if (sub.foreground) enqueue(sub, () => snapshot(sub!));
        } else if (message.type === 'ack' && sub) {
          const eventId = uuid(message.eventId, 'Event');
          const delivery = sub.deliveries.get(eventId) ?? await recoverDelivery(db, processId, sub.connectionId, eventId);
          if (!delivery || message.activityId !== sub.activityId || !Number.isInteger(message.version) || message.version < delivery.event.version ||
              delivery.sentVersion === undefined || message.version > delivery.sentVersion) return;
          if ('saved' in delivery) await delivery.saved;
          await saveAck(db, { processId, connectionId: sub.connectionId, clientId: sub.clientId, delivery, version: message.version, receivedClock, receivedAt });
          sub.deliveries.delete(eventId);
        } else throw new Error('Invalid live message');
      }).catch(error => { log({ component: 'live.message' }, error); socket.close(1008, 'Invalid live message or unavailable storage'); }));
    });
  });
  let reconciling = false;
  const interval = setInterval(() => {
    if (reconciling || stopped) return;
    reconciling = true;
    void track((async () => {
      await register();
      for (const observation of observations.values()) if (!observation.saving) persist(observation);
      // Record every active gateway's observation, even with zero subscribers, so absent writes are distinguishable from zero delivery demand.
      const events = await rows<{ payload: AvailabilityEvent; createdAt: Date; bookingId: string }>(db, `
        SELECT e.payload,e.created_at AS "createdAt",e.booking_id AS "bookingId" FROM outbox_events e
        LEFT JOIN live_observations source ON source.event_id=e.id AND source.process_id=e.origin_process_id AND source.timing='commit_observed'
        WHERE (e.origin_process_id=$1 OR COALESCE(source.observed_at,e.created_at) >= $2::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM live_observations o WHERE o.event_id=e.id AND o.process_id=$1)
        ORDER BY e.created_at LIMIT 100`, [processId, startedAt]);
      for (const e of events) observe({ ...e.payload, bookingId: e.bookingId, createdAt: e.createdAt.toISOString() }, 'pre_commit_proxy', performance.now());
      for (const sub of subscribers) {
        for (const [eventId, delivery] of sub.deliveries) {
          const age = delivery.timing === 'commit_observed' ? performance.now()-delivery.started : Date.now()-Date.parse(delivery.event.createdAt);
          if (age >= 2000) sub.deliveries.delete(eventId);
        }
        sub.buffered = sub.buffered.filter(event => sub.deliveries.has(event.eventId));
        if (!sub.foreground) continue;
        enqueue(sub, async () => {
          await snapshot(sub);
          sub.ready = true; sub.buffered = [];
          for (const delivery of sub.deliveries.values()) { await delivery.saved; await snapshot(sub, delivery.event); }
        });
      }
    })().catch(error => log({ component: 'live.reconcile' }, error)).finally(() => { reconciling = false; }));
  }, options.reconcileMs ?? 1000);
  interval.unref();
  return { committed, published, health: () => ({ processId, measurementFailures }),
    close: async () => {
      stopped = true; clearInterval(interval); for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      while (work.size) await Promise.allSettled([...work]);
      await db.query('UPDATE live_processes SET stopped_at=$2 WHERE process_id=$1', [processId, new Date().toISOString()]);
    } };
}
