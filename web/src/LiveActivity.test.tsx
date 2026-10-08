import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityDetails } from './ActivityDetails';
import { ViewDelivery } from './view-delivery';

const actorId = '11111111-1111-4111-8111-111111111111';
const activity = { id: '22222222-2222-4222-8222-222222222222', hostId: actorId, title: 'Live walk', description: 'Along the marina', meetingLocation: 'Marina gate',
  startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity: 1, confirmedCount: 0, remainingSeats: 1, priceMinor: 0, currency: 'NGN',
  assignment: { experiment: 'group_invites_v1', version: '1', treatmentPercent: 50, variant: 'treatment', assignedAt: '2026-10-08T12:00:00Z' }, invitePolicy: { creationEnabled: true, allowed: true, reason: 'allowed' },
  version: 1, status: 'scheduled', planId: '33333333-3333-4333-8333-333333333333', participants: [] as { id: string; displayName: string }[] };
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  onSend?: (message: Record<string, unknown>) => void;
  constructor() { Socket.instances.push(this); }
  send(value: string) { const message = JSON.parse(value); this.sent.push(message); this.onSend?.(message); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  snapshot(detail = activity, eventId: string | null = null) {
    this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', activityId: detail.id, version: detail.version, eventId, activity: detail }) });
  }
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); Socket.instances = []; });
function setup() {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ data:
    url.endsWith('/booking') ? { booking: null, availability: { ...activity, activityId: activity.id } } :
    url.endsWith('/events') ? { accepted: true } : activity, requestId: 'live-ui' }))));
  render(<ActivityDetails id={activity.id} actorId={actorId} journeyId={actorId} close={() => {}} delivery={new ViewDelivery()} />);
  return Socket.instances[0]!;
}

test('an open socket without a snapshot times out and reconnects while booking stays disabled', async () => {
  vi.useFakeTimers();
  const socket = setup();
  await act(async () => { socket.open(); await vi.advanceTimersByTimeAsync(6500); });
  expect(Socket.instances.length).toBeGreaterThan(1);
  expect(screen.getByText(/details may be stale/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
});

test('live full counts and committed participants render before the corresponding ACK', async () => {
  const socket = setup();
  await screen.findByText('Marina gate');
  expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
  act(() => { socket.open(); socket.snapshot(); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(false));
  const eventId = crypto.randomUUID();
  let observed = false;
  socket.onSend = message => {
    if (message.type !== 'ack') return;
    expect(message.eventId).toBe(eventId);
    expect(message.version).toBe(2);
    expect(screen.getByText('0 of 1 seats remaining · 1 confirmed')).toBeTruthy();
    expect(screen.getByRole('listitem').textContent).toBe('Tunde');
    expect(screen.getByText('This activity is full. Confirmed participants are shown below.')).toBeTruthy();
    observed = true;
  };
  act(() => socket.snapshot({ ...activity, version: 2, confirmedCount: 1, remainingSeats: 0, participants: [{ id: actorId, displayName: 'Tunde' }] }, eventId));
  await waitFor(() => expect(observed).toBe(true));
  expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
});

test('duplicate and older snapshots cannot undo visible membership or reopen a full activity', async () => {
  const socket = setup();
  await screen.findByText('Marina gate');
  const full = { ...activity, version: 2, confirmedCount: 1, remainingSeats: 0, participants: [{ id: actorId, displayName: 'Tunde' }] };
  const eventId = crypto.randomUUID();
  act(() => { socket.open(); socket.snapshot(full, eventId); });
  await screen.findByText('0 of 1 seats remaining · 1 confirmed');
  act(() => { socket.snapshot(full, eventId); socket.snapshot(activity, crypto.randomUUID()); });
  expect(screen.getByText('0 of 1 seats remaining · 1 confirmed')).toBeTruthy();
  expect(screen.getByRole('listitem').textContent).toBe('Tunde');
  expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
});

test('disconnect and reconnect retain usable stale details and resume from the newest authoritative version', async () => {
  vi.useFakeTimers();
  const socket = setup();
  await act(async () => { socket.open(); socket.snapshot(); });
  act(() => socket.close());
  expect(screen.getByText(/Live connection interrupted/)).toBeTruthy();
  expect(screen.getByText('Marina gate')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Book one seat' }).hasAttribute('disabled')).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  const next = Socket.instances[1]!;
  act(() => { next.open(); next.snapshot({ ...activity, version: 2, confirmedCount: 1, remainingSeats: 0, participants: [{ id: actorId, displayName: 'Tunde' }] }); });
  expect(screen.getByText('Live availability connected.')).toBeTruthy();
  expect(screen.getByRole('listitem').textContent).toBe('Tunde');
  expect(next.sent[0]).toMatchObject({ type: 'subscribe', activityId: activity.id, clientId: socket.sent[0]!.clientId });
});

test('hidden views do not ACK and foreground refresh applies fresh membership before ACK', async () => {
  const socket = setup();
  await screen.findByText('Marina gate');
  act(() => { socket.open(); socket.snapshot(); });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  const eventId = crypto.randomUUID();
  const full = { ...activity, version: 2, confirmedCount: 1, remainingSeats: 0, participants: [{ id: actorId, displayName: 'Tunde' }] };
  act(() => socket.snapshot(full, eventId));
  expect(socket.sent.some(m => m.type === 'ack')).toBe(false);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => { document.dispatchEvent(new Event('visibilitychange')); socket.snapshot(full, eventId); });
  await waitFor(() => expect(socket.sent.some(m => m.type === 'ack' && m.eventId === eventId)).toBe(true));
  expect(screen.getByRole('listitem').textContent).toBe('Tunde');
  expect(socket.sent).toContainEqual({ type: 'foreground', foreground: false });
  expect(socket.sent).toContainEqual({ type: 'foreground', foreground: true });
  vi.restoreAllMocks();
});

test('late callbacks from a replaced socket cannot mark the recovered view stale or schedule another connection', async () => {
  vi.useFakeTimers();
  const old = setup();
  await act(async () => { old.open(); old.snapshot(); old.close(); await vi.advanceTimersByTimeAsync(500); });
  const current = Socket.instances[1]!;
  act(() => { current.open(); current.snapshot(); old.onerror?.(); old.onclose?.(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('Live availability connected.')).toBeTruthy();
  expect(Socket.instances).toHaveLength(2);
});

test('foreground return gives the healthy socket a fresh watchdog window', async () => {
  vi.useFakeTimers();
  const socket = setup();
  await act(async () => { socket.open(); socket.snapshot(); });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(socket.readyState).toBe(Socket.OPEN);
  expect(Socket.instances).toHaveLength(1);
  act(() => socket.snapshot());
  expect(screen.getByText('Live availability connected.')).toBeTruthy();
  vi.restoreAllMocks();
});

test('shared live availability retains the actor-specific invitation policy from HTTP', async () => {
  const socket=setup();
  await screen.findByText('This activity is assigned to the invitation experience.');
  act(()=>{socket.open();socket.snapshot({...activity,version:2,invitePolicy:{creationEnabled:true,allowed:false,reason:'host_or_booker_required'}});});
  expect(screen.getByText('This activity is assigned to the invitation experience.')).toBeTruthy();
  expect(screen.queryByText('Book a seat or host this activity to create invitations.')).toBeNull();
});

test('actor refresh merges policy with newer live membership and ACKs only after the new view renders', async () => {
  vi.stubGlobal('WebSocket',Socket);
  const nextActor='44444444-4444-4444-8444-444444444444';
  let finish!: (response:Response)=>void;
  vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=> {
    if(url.endsWith('/events')) return new Response(JSON.stringify({data:{accepted:true},requestId:'actor-live'}));
    if((options.headers as Record<string,string>)['X-Demo-Actor-Id']===nextActor) return new Promise<Response>(resolve=>{finish=resolve;});
    return new Response(JSON.stringify({data:activity,requestId:'actor-live'}));
  }));
  const delivery=new ViewDelivery();
  const view=render(<ActivityDetails id={activity.id} actorId={actorId} journeyId={actorId} close={()=>{}} delivery={delivery}/>);
  await screen.findByText('Marina gate');
  const socket=Socket.instances[0]!;
  act(()=>{socket.open();socket.snapshot();});
  view.rerender(<ActivityDetails id={activity.id} actorId={nextActor} journeyId={actorId} close={()=>{}} delivery={delivery}/>);
  const eventId=crypto.randomUUID();
  const full={...activity,version:2,remainingSeats:0,confirmedCount:1,participants:[{id:actorId,displayName:'Tunde'}]};
  act(()=>socket.snapshot(full,eventId));
  expect(socket.sent.some(message=>message.type==='ack')).toBe(false);
  let acknowledged=false;
  socket.onSend=message=>{
    if(message.type!=='ack') return;
    expect(screen.getByText('0 of 1 seats remaining · 1 confirmed')).toBeTruthy();
    expect(screen.getByText('Book a seat or host this activity to create invitations.')).toBeTruthy();
    expect(screen.getByRole('listitem').textContent).toBe('Tunde'); acknowledged=true;
  };
  await act(async()=>finish(new Response(JSON.stringify({data:{...activity,invitePolicy:{creationEnabled:true,allowed:false,reason:'host_or_booker_required'}},requestId:'actor-live'}))));
  await waitFor(()=>expect(acknowledged).toBe(true));
});
