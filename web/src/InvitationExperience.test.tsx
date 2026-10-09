// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityDetails } from './ActivityDetails';
import { ViewDelivery } from './view-delivery';
import { ViewDeliveryStatus } from './ViewDeliveryStatus';

const activity = { id: '22222222-2222-4222-8222-222222222222', hostId: '11111111-1111-4111-8111-111111111111', title: 'Cohort walk', description: 'A gentle walk.', meetingLocation: 'Marina gate',
  startsAt: '2030-01-15T07:00:00Z', timezone: 'Africa/Lagos', capacity: 4, confirmedCount: 0, remainingSeats: 4,
  priceMinor: 0, currency: 'NGN', version: 1, status: 'scheduled', planId: '33333333-3333-4333-8333-333333333333', participants: [],
  assignment: { experiment: 'group_invites_v1', version: '1', treatmentPercent: 50, variant: 'treatment', assignedAt: '2026-10-08T12:00:00Z' }, invitePolicy: {creationEnabled:true,allowed:true,reason:'allowed'} };
const response = (data: unknown) => new Response(JSON.stringify({ data, requestId: 'test' }), { status: 200 });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
for (const [variant, enabled, copy] of [
  ['treatment', true, 'Good plans are better together.'],
  ['control', true, 'This activity supports ordinary booking. New invitations are unavailable.'],
  ['treatment', false, 'New invitations are temporarily unavailable. You can still book a seat.'],
] as const) {
  test(`renders ${variant} with creation ${enabled} before emitting deduplicated exposure`, async () => {
    const events: { id: string; name: string }[] = [];
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (url.endsWith('/events')) {
        const event = JSON.parse(options.body as string);
        events.push(event);
        return Promise.resolve(response({ id: event.id, accepted: true }));
      }
      return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const delivery = new ViewDelivery();
    render(<StrictMode><ActivityDetails id={activity.id} actorId="" journeyId="44444444-4444-4444-8444-444444444444" close={() => {}} delivery={delivery} /></StrictMode>);
    expect(screen.queryByRole('region', { name: 'Invitations' })).toBeNull();
    expect(events).toHaveLength(0);
    finish(response({ ...activity, assignment: { ...activity.assignment, variant }, invitePolicy: { creationEnabled: enabled, allowed: variant === 'treatment' && enabled, reason: !enabled ? 'creation_disabled' : variant === 'control' ? 'control' : 'allowed' } }));
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.getByText('Select a demo identity to book one seat.')).toBeTruthy();
    await waitFor(() => expect(events.filter(event => event.name === 'experiment_exposed')).toHaveLength(1));
    expect(events.filter(event => event.name === 'activity_viewed')).toHaveLength(1);
  });
}

test('failed exposure delivery preserves the shown activity and retries the original event', async () => {
  const events: Record<string, unknown>[] = [];
  let failed = false;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) {
      const event = JSON.parse(options.body as string);
      events.push(event);
      if (event.name === 'experiment_exposed' && !failed) { failed = true; return Promise.reject(new Error('Exposure unavailable')); }
      return Promise.resolve(response({ id: event.id, accepted: true }));
    }
    return Promise.resolve(response(activity));
  }));
  const delivery = new ViewDelivery();
  render(<><ActivityDetails id={activity.id} actorId="" journeyId="44444444-4444-4444-8444-444444444444" close={() => {}} delivery={delivery} /><ViewDeliveryStatus delivery={delivery} /></>);
  await screen.findByText(/Exposure unavailable/);
  expect(screen.getByText('Good plans are better together.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry view tracking' }).closest('details')?.open).toBe(false);
  fireEvent.click(screen.getByText(/Reviewer diagnostics/, { selector: 'summary' }));
  expect(screen.getByRole('button', { name: 'Retry view tracking' }).closest('details')?.open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry view tracking' }));
  await waitFor(() => expect(events.filter(event => event.name === 'experiment_exposed')).toHaveLength(2));
  const exposures = events.filter(event => event.name === 'experiment_exposed');
  expect(exposures[1]).toEqual(exposures[0]);
});

test('missing invitation fields fail closed without hiding activity details or ordinary booking', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (url.endsWith('/events')) return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true}));
    return Promise.resolve(response({...activity,assignment:undefined,invitePolicy:undefined}));
  }));
  render(<ActivityDetails id={activity.id} actorId="" journeyId="44444444-4444-4444-8444-444444444444" close={() => {}} delivery={new ViewDelivery()} />);
  expect(await screen.findByText(/Invitation availability could not be verified/)).toBeTruthy();
  expect(screen.getByText('Marina gate')).toBeTruthy();
  expect(screen.getByText('Select a demo identity to book one seat.')).toBeTruthy();
});

test('missing or malformed assignment and policy fields fail closed at the rendered boundary', async () => {
  const badAssignments = [undefined, {}, [], {...activity.assignment,variant:['treatment']}, {...activity.assignment,experiment:'wrong'},
    {...activity.assignment,version:''}, {...activity.assignment,treatmentPercent:101}, {...activity.assignment,treatmentPercent:0.5}, {...activity.assignment,assignedAt:'invalid'}];
  const badPolicies = [undefined, null, {}, [], {creationEnabled:true,reason:'allowed'}, {allowed:true,reason:'allowed'},
    {creationEnabled:true,allowed:false}, {creationEnabled:'true',allowed:true,reason:'allowed'},
    {creationEnabled:false,allowed:true,reason:'allowed'}, {creationEnabled:true,allowed:true,reason:['allowed']},
    {creationEnabled:true,allowed:true,reason:'typo'}, {creationEnabled:true,allowed:false,reason:'control'}];
  for (const patch of [...badAssignments.map(assignment => ({assignment})), ...badPolicies.map(invitePolicy => ({invitePolicy}))]) {
    const events: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options: RequestInit) => {
      if (url.endsWith('/events')) { const event=JSON.parse(options.body as string); events.push(event); return Promise.resolve(response({id:event.id,accepted:true})); }
      return Promise.resolve(response({...activity,...patch}));
    }));
    const view=render(<ActivityDetails id={activity.id} actorId="" journeyId="44444444-4444-4444-8444-444444444444" close={() => {}} delivery={new ViewDelivery()} />);
    await screen.findByText('Invitation availability could not be verified. You can still book a seat.');
    expect(screen.getByText('Marina gate')).toBeTruthy();
    expect(screen.getByText('Select a demo identity to book one seat.')).toBeTruthy();
    await waitFor(() => expect(events.filter(e => e.name==='experiment_exposed')).toHaveLength(1));
    expect(events.find(e=>e.name==='experiment_exposed')?.displayedInviteState).toEqual({enabled:false,creationEnabled:false,reason:'assignment_unavailable'});
    view.unmount();
  }
});

// A new booking requires the actual rendered live boundary to have recovered.
function recoveredLive() {
  vi.stubGlobal('WebSocket',class {
    static OPEN=1;
    readyState=1;
    onopen:(()=>void)|null=null;
    onmessage:((event:{data:string})=>void)|null=null;
    constructor(){queueMicrotask(()=>this.onopen?.());}
    send(value:string){
      if(JSON.parse(value).type!=='subscribe')return;
      queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'snapshot',eventId:null,activityId:activity.id,version:activity.version,activity})}));
    }
    close(){this.readyState=3;}
  });
}
test('unchanged booking/details refresh does not resend exposure; a changed displayed policy does', async () => {
  recoveredLive();
  const events: Record<string, unknown>[]=[];
  let booked=false;
  let enabled=true;
  const availability=()=>({activityId:activity.id,planId:activity.planId,capacity:4,confirmedCount:booked?1:0,remainingSeats:booked?3:4,version:booked?2:1});
  const booking={id:'55555555-5555-4555-8555-555555555555',activityId:activity.id,planId:activity.planId,userId:activity.hostId,priceMinor:0,currency:'NGN',confirmedAt:'2026-10-08T15:00:00Z'};
  let detailReads=0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string,options: RequestInit)=>{
    if(url.endsWith('/events')){const event=JSON.parse(options.body as string);events.push(event);return Promise.resolve(response({id:event.id,accepted:true}));}
    if(url.endsWith('/bookings')){booked=true;return Promise.resolve(response({booking,availability:availability()}));}
    if(url.endsWith('/booking'))return Promise.resolve(response({booking:booked?booking:null,availability:availability()}));
    detailReads++;
    return Promise.resolve(response({...activity,assignment:{...activity.assignment},confirmedCount:booked?1:0,remainingSeats:booked?3:4,
      invitePolicy:{creationEnabled:enabled,allowed:enabled,reason:enabled?'allowed':'creation_disabled'}}));
  }));
  render(<ActivityDetails id={activity.id} actorId={activity.hostId} journeyId="44444444-4444-4444-8444-444444444444" close={()=>{}} delivery={new ViewDelivery()}/>);
  const button=await screen.findByRole('button',{name:'Book one seat'});
  await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
  await waitFor(()=>expect(events.filter(e=>e.name==='experiment_exposed')).toHaveLength(1));
  fireEvent.click(button);
  await screen.findByText('Your seat is confirmed.');
  await waitFor(()=>expect(detailReads).toBe(2));
  await screen.findByText('3 of 4 seats remaining · 1 confirmed');
  expect(events.filter(e=>e.name==='experiment_exposed')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Refresh details'}));
  await waitFor(()=>expect(detailReads).toBe(3));
  await screen.findByText('Good plans are better together.');
  expect(events.filter(e=>e.name==='experiment_exposed')).toHaveLength(1);
  enabled=false;
  fireEvent.click(screen.getByRole('button',{name:'Refresh details'}));
  await screen.findByText('New invitations are temporarily unavailable. You can still book a seat.');
  await waitFor(()=>expect(events.filter(e=>e.name==='experiment_exposed')).toHaveLength(2));
  const exposures=events.filter(e=>e.name==='experiment_exposed');
  expect(exposures[1]?.id).not.toBe(exposures[0]?.id);
  expect(exposures[0]?.displayedInviteState).toEqual({enabled:true,creationEnabled:true,reason:'allowed'});
  expect(exposures[1]?.displayedInviteState).toEqual({enabled:false,creationEnabled:false,reason:'creation_disabled'});
});

test('ordinary booking still confirms when invitation policy fields are malformed', async () => {
  recoveredLive();
  const booking={id:'55555555-5555-4555-8555-555555555555',activityId:activity.id,planId:activity.planId,userId:activity.hostId,priceMinor:0,currency:'NGN',confirmedAt:'2026-10-08T15:00:00Z'};
  let booked=false;
  vi.stubGlobal('fetch',vi.fn().mockImplementation((url:string,options:RequestInit)=>{
    if(url.endsWith('/events'))return Promise.resolve(response({id:JSON.parse(options.body as string).id,accepted:true}));
    if(url.endsWith('/bookings'))booked=true;
    if(url.endsWith('/booking')||url.endsWith('/bookings'))return Promise.resolve(response({booking:booked?booking:null,availability:{activityId:activity.id,planId:activity.planId,capacity:4,confirmedCount:booked?1:0,remainingSeats:booked?3:4,version:booked?2:1}}));
    return Promise.resolve(response({...activity,invitePolicy:{reason:'allowed'}}));
  }));
  render(<ActivityDetails id={activity.id} actorId={activity.hostId} journeyId="44444444-4444-4444-8444-444444444444" close={()=>{}} delivery={new ViewDelivery()}/>);
  await screen.findByText('Invitation availability could not be verified. You can still book a seat.');
  const button=screen.getByRole('button',{name:'Book one seat'});
  await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
  expect(await screen.findByText('Your seat is confirmed.')).toBeTruthy();
});

test('identity change waits for its own policy and never reports the previous actor’s enabled state', async () => {
  const outsider='66666666-6666-4666-8666-666666666666';
  const events: Record<string,unknown>[]=[];
  let finish!: (value:Response)=>void;
  const headers: string[]=[];
  vi.stubGlobal('fetch',vi.fn().mockImplementation((url:string,options:RequestInit)=>{
    if(url.endsWith('/events')){const event=JSON.parse(options.body as string);events.push(event);return Promise.resolve(response({id:event.id,accepted:true}));}
    if(url.endsWith('/booking'))return Promise.resolve(response({booking:null,availability:{activityId:activity.id,planId:activity.planId,capacity:4,confirmedCount:0,remainingSeats:4,version:1}}));
    const actor=(options.headers as Record<string,string>)['X-Demo-Actor-Id'];headers.push(actor!);
    return actor===outsider?new Promise<Response>(resolve=>{finish=resolve;}):Promise.resolve(response(activity));
  }));
  const delivery=new ViewDelivery();
  const props={id:activity.id,journeyId:'44444444-4444-4444-8444-444444444444',close:()=>{},delivery};
  const view=render(<ActivityDetails {...props} actorId={activity.hostId}/>);
  await screen.findByText('Good plans are better together.');
  await waitFor(()=>expect(events.filter(e=>e.name==='experiment_exposed')).toHaveLength(1));
  view.rerender(<ActivityDetails {...props} actorId={outsider}/>);
  await waitFor(()=>expect(headers).toContain(outsider));
  expect(events.filter(e=>e.name==='experiment_exposed'&&e.actorId===outsider)).toHaveLength(0);
  finish(response({...activity,invitePolicy:{creationEnabled:true,allowed:false,reason:'host_or_booker_required'}}));
  await screen.findByText('Book a seat or host this activity to create invitations.');
  await waitFor(()=>expect(events.filter(e=>e.name==='experiment_exposed'&&e.actorId===outsider)).toHaveLength(1));
  expect(events.find(e=>e.name==='experiment_exposed'&&e.actorId===outsider)?.displayedInviteState).toEqual({enabled:false,creationEnabled:true,reason:'host_or_booker_required'});
});
