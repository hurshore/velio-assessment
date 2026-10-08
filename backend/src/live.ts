import { deliveryTargetMs, maxLiveConnections, maxPendingObservations, maxSubscriberQueue, reconcileBatchSize } from './live-policy.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { activityDetail } from './activities.js';
import { DomainError, exact, object, rows, uuid, type Database } from './domain.js';
import { reportFailure, type FailureReporter } from './diagnostics.js';
import type { AvailabilityEvent } from './outbox.js';
import { recoverDelivery, saveAck, saveObservation, type DeliveryClock, type Observation, type Timing } from './live-store.js';

interface Delivery extends DeliveryClock { saved: Promise<void> }
interface Subscriber {
  socket: WebSocket; connectionId: string; clientId: string; activityId: string; foreground: boolean;
  initialVersion?: number; ready: boolean; buffered: AvailabilityEvent[]; deliveries: Map<string, Delivery>; running: Promise<void>; queued: number; reconcileQueued: boolean;
}
interface PendingObservation extends Observation { subscribers: Subscriber[]; saving: boolean }
export function attachLive(server: Server, db: Database, origin: string, options: { processId?: string; reconcileMs?: number; accepting?: () => boolean; log?: FailureReporter } = {}) {
  const processId = options.processId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const log = options.log ?? reportFailure;
  const sockets = new Set<WebSocket>();
  const subscribers = new Set<Subscriber>();
  const observations = new Map<string, PendingObservation>();
  const acknowledgements = new Map<string, { context: Parameters<typeof saveAck>[1]; saving: boolean }>();
  let measurementFailures = 0;
  let registration: Promise<void> | undefined;
  let stopped = false;
  let cutoff: string | undefined;
  let cutoffSubscribers: Subscriber[] | undefined;
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
    socket.on('error', error => log({ component: 'live.upgrade' }, error));
    if (stopped || options.accepting?.() === false || sockets.size >= maxLiveConnections) { socket.destroy(); return; }
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
  async function snapshot(sub: Subscriber, event?: AvailabilityEvent, shared?: ReturnType<typeof activityDetail>) {
    const activity = await (shared ?? activityDetail(db, sub.activityId));
    let measuredEventId = event?.eventId ?? null;
    sub.initialVersion ??= Number(activity.version);
    if (event) {
      const delivery = sub.deliveries.get(event.eventId);
      if (delivery?.sentVersion !== Number(activity.version)) {
        try { await db.query(`UPDATE live_deliveries SET sent_version=GREATEST(COALESCE(sent_version,0),$4)
          WHERE event_id=$1 AND process_id=$2 AND connection_id=$3`, [event.eventId, processId, sub.connectionId, activity.version]); } catch (error) { failed(error); measuredEventId = null; }
        if (delivery && measuredEventId) delivery.sentVersion = Number(activity.version);
      }
    }
    send(sub, { type: 'snapshot', eventId: measuredEventId, activityId: sub.activityId,
      version: activity.version, capacity: activity.capacity, confirmedCount: activity.confirmedCount,
      remainingSeats: activity.remainingSeats, activity });
  }
  function enqueue(sub: Subscriber, operation: () => Promise<void>) {
    if (stopped) return;
    if (sub.queued >= maxSubscriberQueue) { sub.socket.close(1013, 'Too many queued updates'); return; }
    sub.queued++;
    sub.running = track(sub.running.then(() => sub.socket.readyState === WebSocket.OPEN ? operation() : undefined).catch(error => {
      if (error instanceof DomainError && error.status === 404) { sub.socket.close(1008, 'Activity not found'); return; }
      log({ component: 'live.snapshot' }, error);
      send(sub, { type: 'unavailable', message: 'Live details are unavailable. Refresh or reconnect.' });
    }).finally(() => { sub.queued--; }));
  }
  function persist(observation: PendingObservation) {
    observation.saving = true;
    const saved = track(register().then(() => saveObservation(db, processId, observation)));
    void saved.then(() => observations.delete(observation.event.eventId)).catch(failed).finally(() => { observation.saving = false; });
    for (const sub of observation.subscribers) {
      const existing = sub.deliveries.get(observation.event.eventId);
      if (existing) existing.saved = saved;
      else sub.deliveries.set(observation.event.eventId, { event: observation.event, timing: observation.timing, started: observation.started, saved });
      if (!sub.ready) {
        if (!sub.buffered.some(event => event.eventId === observation.event.eventId)) sub.buffered.push(observation.event);
      } else enqueue(sub, async () => { try { await saved; } catch { await snapshot(sub); return; }
        await snapshot(sub, observation.event); });
      if (sub.buffered.length > maxSubscriberQueue || sub.deliveries.size > maxSubscriberQueue) sub.socket.close(1013, 'Too many unacknowledged updates');
    }
  }
  function observe(event: AvailabilityEvent, timing: Timing, started: number) {
    if (stopped && !cutoff) return;
    if (observations.has(event.eventId)) return;
    // Failed writes retain their original cohort and clock; the outbox/process ledger exposes any gap.
    if (observations.size >= maxPendingObservations) { failed(new Error('Live observation retry queue is full')); return; }
    const relevant = (cutoffSubscribers ?? [...subscribers]).filter(s => s.activityId === event.activityId && s.foreground &&
      (timing === 'commit_observed' || s.initialVersion === undefined || event.version > s.initialVersion));
    const observation: PendingObservation = { event, timing, started, observedAt: new Date().toISOString(), subscribers: relevant, saving: false };
    observations.set(event.eventId, observation);
    persist(observation);
  }
  async function persistAcknowledgement(key: string, pending: { context: Parameters<typeof saveAck>[1]; saving: boolean }) {
    if (pending.saving) return;
    pending.saving = true;
    try { await track(saveAck(db, pending.context)); acknowledgements.delete(key); }
    catch (error) {
      failed(error);
      // Keep the original arrival clock; rotate failed writes so later ACKs can retry too.
      acknowledgements.delete(key); acknowledgements.set(key,pending);
    } finally { pending.saving = false; }
  }
  // Called synchronously immediately after COMMIT returns, before unrelated telemetry awaits.
  function committed(event: AvailabilityEvent) { if (!stopped) observe(event, 'commit_observed', performance.now()); }
  function published(message: string) {
    if (stopped) return Promise.resolve();
    return track((async () => {
      const value = object(JSON.parse(message));
      exact(value, ['eventId','activityId','planId','bookingId','createdAt','version','capacity','confirmedCount','remainingSeats']);
      uuid(value.bookingId, 'Booking');
      if (value.planId !== undefined) uuid(value.planId, 'Plan');
      if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid event timestamp');
      for (const key of ['version','capacity','confirmedCount','remainingSeats']) {
        if (!Number.isInteger(value[key]) || Number(value[key]) < 0) throw new Error('Invalid availability counts');
      }
      if (Number(value.version) < 1 || Number(value.capacity) < 1 || Number(value.confirmedCount)+Number(value.remainingSeats) !== value.capacity) throw new Error('Invalid availability snapshot');
      const eventId = uuid(value.eventId, 'Event').toLowerCase();
      uuid(value.activityId, 'Activity');
      if (value.version !== undefined && (!Number.isInteger(value.version) || Number(value.version) < 1)) throw new Error('Invalid event version');
      const [event] = await rows<EventRow>(db,
        'SELECT payload,created_at AS "createdAt",booking_id AS "bookingId",origin_process_id AS "originProcessId" FROM outbox_events WHERE id=$1', [eventId]);
      // Local origin uses only its synchronous COMMIT clock. Publication must never replace it with a proxy.
      if (!event || stopped || event.originProcessId === processId) return;
      if (uuid(value.activityId, 'Activity').toLowerCase() !== event.payload.activityId || uuid(value.bookingId, 'Booking').toLowerCase() !== event.bookingId) throw new Error('Event identifiers do not match persisted context');
      const [existing] = await rows(db, 'SELECT 1 FROM live_observations WHERE event_id=$1 AND process_id=$2', [eventId, processId]);
      if (!existing && !stopped) observe(toEvent(event), 'pre_commit_proxy', performance.now());
    })());
  }
  wss.on('connection', socket => {
    sockets.add(socket);
    let sub: Subscriber | undefined;
    let messageQueue = Promise.resolve();
    let queuedMessages = 0;
    const handshake = setTimeout(() => { if (!sub) socket.close(1008, 'Subscription required'); }, 5000);
    socket.on('error', error => log({ component: 'live.socket' }, error));
    socket.on('close', () => { clearTimeout(handshake); sockets.delete(socket); if (sub) subscribers.delete(sub); });
    socket.on('message', data => {
      if (stopped) return;
      if (++queuedMessages > maxSubscriberQueue) { socket.close(1013, 'Too many queued messages'); return; }
      const receivedClock = performance.now();
      const receivedAt = Date.now();
      messageQueue = track(messageQueue.then(async () => {
        const message = object(JSON.parse(data.toString()));
        if (socket.readyState !== WebSocket.OPEN) return;
        if (message.type === 'subscribe' && !sub) {
          exact(message, ['type','clientId','activityId','foreground']);
          if (typeof message.foreground !== 'boolean') throw new Error('Foreground must be boolean');
          await register();
          sub = { socket, connectionId: randomUUID(), clientId: uuid(message.clientId, 'Client').toLowerCase(),
            activityId: uuid(message.activityId, 'Activity').toLowerCase(), foreground: message.foreground === true,
            ready: false, buffered: [], deliveries: new Map(), running: Promise.resolve(), queued: 0, reconcileQueued: false };
          subscribers.add(sub); clearTimeout(handshake);
          // Register/buffer before reading; the initial version filters subsequent proxy deliveries only.
          const current = sub;
          enqueue(current, async () => {
            await snapshot(current);
            current.ready = true;
            for (const event of current.buffered.splice(0)) {
              const delivery = current.deliveries.get(event.eventId);
              if (!delivery) { await snapshot(current); continue; }
              try { await delivery.saved; } catch { await snapshot(current); continue; }
              await snapshot(current, event);
            }
          });
        } else if (message.type === 'foreground' && sub && typeof message.foreground === 'boolean') {
          exact(message, ['type','foreground']);
          sub.foreground = message.foreground;
          if (sub.foreground) enqueue(sub, () => snapshot(sub!));
        } else if (message.type === 'ack' && sub) {
          exact(message, ['type','eventId','activityId','version']);
          const eventId = uuid(message.eventId, 'Event').toLowerCase();
          const activityId = uuid(message.activityId, 'Activity').toLowerCase();
          const delivery = sub.deliveries.get(eventId) ?? await recoverDelivery(db, processId, sub.connectionId, eventId);
          if (!delivery || activityId !== sub.activityId || !Number.isInteger(message.version) || Number(message.version) < delivery.event.version ||
              delivery.sentVersion === undefined || Number(message.version) > delivery.sentVersion) return;
          if ('saved' in delivery) await delivery.saved;
          const key = `${sub.connectionId}:${eventId}`;
          let pending = acknowledgements.get(key);
          if (!pending) {
            if (acknowledgements.size >= maxPendingObservations) { failed(new Error('ACK persistence queue is full')); return; }
            pending = { context: { processId, connectionId: sub.connectionId, clientId: sub.clientId, delivery, version: Number(message.version), receivedClock, receivedAt }, saving: false };
            acknowledgements.set(key,pending);
          }
          await persistAcknowledgement(key,pending);
          sub.deliveries.delete(eventId);
        } else throw new Error('Invalid live message');
      }).catch(error => { log({ component: 'live.message' }, error); socket.close(1008, 'Invalid live message or unavailable storage'); }).finally(() => { queuedMessages--; }));
    });
  });
  interface EventRow { payload: Omit<AvailabilityEvent,'bookingId'|'createdAt'>; createdAt: Date; bookingId: string; originProcessId?: string; cursorAt?: string; observed?: boolean }
  function toEvent(row: EventRow): AvailabilityEvent { return { ...row.payload, bookingId: row.bookingId, createdAt: row.createdAt.toISOString() }; }
  let cursor: { createdAt: string; eventId: string } | undefined;
  async function reconcileObservations(final = false): Promise<boolean> {
    // Separate indexed ranges include transactions begun before subscription/process start.
    // Cursor advances past failed rows; retry state and wraparound preserve unresolved observations.
    const events = await rows<EventRow>(db, `WITH candidates AS (
      (SELECT id,created_at FROM outbox_events WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
        AND (created_at,id) > ($4::timestamptz,$5::uuid) ORDER BY created_at,id LIMIT $6)
      UNION
      (SELECT id,created_at FROM outbox_events WHERE origin_process_id=$1 AND created_at < $2::timestamptz
        AND (created_at,id) > ($4::timestamptz,$5::uuid) ORDER BY created_at,id LIMIT $6)
      UNION
      (SELECT e.id,e.created_at FROM live_observations source JOIN outbox_events e ON e.id=source.event_id
        WHERE source.timing='commit_observed' AND source.observed_at >= $2::timestamptz AND source.observed_at < $3::timestamptz
          AND e.created_at < $2::timestamptz AND (e.created_at,e.id) > ($4::timestamptz,$5::uuid)
        ORDER BY e.created_at,e.id LIMIT $6)
    ) SELECT e.payload,e.created_at AS "createdAt",e.created_at::text AS "cursorAt",e.booking_id AS "bookingId",e.origin_process_id AS "originProcessId",
        (EXISTS (SELECT 1 FROM live_observations o WHERE o.event_id=e.id AND o.process_id=$1)
          OR COALESCE(source.observed_at,e.created_at) >= $3::timestamptz) AS observed
      FROM candidates c JOIN outbox_events e ON e.id=c.id
      LEFT JOIN live_observations source ON source.event_id=e.id AND source.process_id=e.origin_process_id AND source.timing='commit_observed'
      ORDER BY e.created_at,e.id LIMIT $6`, [processId, startedAt, cutoff ?? new Date().toISOString(),
      cursor?.createdAt ?? '1970-01-01T00:00:00Z', cursor?.eventId ?? '00000000-0000-0000-0000-000000000000', reconcileBatchSize]);
    for (const row of events) {
      cursor = { createdAt: row.cursorAt!, eventId: row.payload.eventId };
      if (!row.observed && row.originProcessId !== processId) observe(toEvent(row), 'pre_commit_proxy', performance.now());
    }
    if (events.length < reconcileBatchSize) { cursor = undefined; return false; }
    if (final) await Promise.allSettled([...work]);
    return true;
  }
  let reconciling = false;
  const interval = setInterval(() => {
    if (reconciling || stopped) return;
    reconciling = true;
    void track((async () => {
      await register();
      for (const [key,pending] of [...acknowledgements].slice(0,reconcileBatchSize)) void track(persistAcknowledgement(key,pending));
      for (const observation of observations.values()) if (!observation.saving) persist(observation);
      await reconcileObservations();
      const snapshots = new Map<string, ReturnType<typeof activityDetail>>();
      for (const sub of subscribers) {
        for (const [eventId, delivery] of sub.deliveries) {
          const age = delivery.timing === 'commit_observed' ? performance.now()-delivery.started : Date.now()-Date.parse(delivery.event.createdAt);
          if (age >= deliveryTargetMs) sub.deliveries.delete(eventId);
        }
        sub.buffered = sub.buffered.filter(event => sub.deliveries.has(event.eventId));
        if (!sub.foreground || sub.reconcileQueued) continue;
        sub.reconcileQueued = true;
        enqueue(sub, async () => {
          try {
            let shared = snapshots.get(sub.activityId);
            if (!shared) { shared = activityDetail(db, sub.activityId); snapshots.set(sub.activityId, shared); }
            await snapshot(sub, undefined, shared);
            sub.ready = true; sub.buffered = [];
            for (const delivery of sub.deliveries.values()) {
              try { await delivery.saved; } catch { continue; }
              await snapshot(sub, delivery.event, shared);
            }
          } finally { sub.reconcileQueued = false; }
        });
      }
    })().catch(error => log({ component: 'live.reconcile' }, error)).finally(() => { reconciling = false; }));
  }, options.reconcileMs ?? 1000);
  interval.unref();
  let closing: Promise<void> | undefined;
  return { committed, published, health: () => ({ processId, measurementFailures }),
    close: () => closing ??= (async () => {
      // HTTP has drained first. Capture one eligibility bound before refusing observations/upgrades.
      cutoff = new Date().toISOString(); cutoffSubscribers = [...subscribers].map(sub => ({ ...sub })); stopped = true; clearInterval(interval);
      try {
        await register();
        await db.query('UPDATE live_processes SET stopped_at=$2 WHERE process_id=$1', [processId, cutoff]);
        while (work.size) await Promise.allSettled([...work]);
        cursor = undefined;
        while (await reconcileObservations(true)) { /* Drain indexed batches through the cutoff. */ }
        for (const observation of observations.values()) if (!observation.saving) persist(observation);
      } finally {
        // A cutoff/reconciliation storage error must still drain already-started writes.
        while (work.size) await Promise.allSettled([...work]);
        for (const socket of sockets) socket.terminate();
        await new Promise<void>(resolve => wss.close(() => resolve()));
      }
    })() };
}
