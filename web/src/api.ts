import { isRecord, parseEnvelope, unexpectedResponseMessage } from './response-envelope';
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export interface Identity {
  id: string; displayName: string; generation: number; acquisitionParentId: string | null; acquisitionRootId: string;
  synthetic: boolean; test: boolean;
}
export interface Activity {
  id: string; hostId: string; title: string; description: string; meetingLocation: string; startsAt: string; timezone: string;
  capacity: number; confirmedCount: number; remainingSeats: number; priceMinor: number; currency: string; version: number;
  status: string; planId: string; participants?: { id: string; displayName: string }[];
}
export class ApiError extends Error {
  constructor(public code: string, message: string, public retryable: boolean, public requestId: string) {
    super(`${message} (Request: ${requestId})`);
  }
}
export async function api(path: string, options: { body?: unknown; actorId?: string; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<unknown> {
  const response = await fetch(apiBase + '/api' + path, { method: options.body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.actorId ? { 'X-Demo-Actor-Id': options.actorId } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(unexpectedResponseMessage);
    throw error;
  }
  const envelope = parseEnvelope(response.status, body);
  if (envelope.kind === 'error') {
    const { code, message, retryable } = envelope.error;
    throw new ApiError(code, message, retryable, envelope.requestId);
  }
  return envelope.data;
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('The API returned an unexpected response.');
  return value;
}
export function parseIdentity(value: unknown): Identity {
  const data = record(value);
  if (typeof data.id !== 'string' || typeof data.displayName !== 'string' || !Number.isInteger(data.generation) ||
    typeof data.acquisitionRootId !== 'string' || !(data.acquisitionParentId === null || typeof data.acquisitionParentId === 'string') ||
    typeof data.synthetic !== 'boolean' || typeof data.test !== 'boolean') throw new Error('The API returned an unexpected identity.');
  return data as unknown as Identity;
}
export function parseActivity(value: unknown): Activity {
  const data = record(value);
  for (const key of ['id', 'hostId', 'title', 'description', 'meetingLocation', 'startsAt', 'timezone', 'currency', 'status', 'planId']) {
    if (typeof data[key] !== 'string') throw new Error('The API returned an unexpected activity.');
  }
  for (const key of ['capacity', 'confirmedCount', 'remainingSeats', 'priceMinor', 'version']) {
    if (!Number.isInteger(data[key])) throw new Error('The API returned an unexpected activity.');
  }
  if (!Number.isFinite(Date.parse(data.startsAt as string))) throw new Error('The API returned an invalid start time.');
  try { new Intl.DateTimeFormat('en', { timeZone: data.timezone as string }); }
  catch { throw new Error('The API returned an invalid timezone.'); }
  if (data.participants !== undefined) {
    if (!Array.isArray(data.participants)) throw new Error('The API returned invalid participants.');
    for (const value of data.participants) {
      const participant = record(value);
      if (typeof participant.id !== 'string' || typeof participant.displayName !== 'string') throw new Error('The API returned invalid participants.');
    }
  }
  return data as unknown as Activity;
}
export type ActivityDetail = Activity & { participants: NonNullable<Activity['participants']> };
export function parseActivityDetail(value: unknown): ActivityDetail {
  const activity = parseActivity(value);
  if (!activity.participants) throw new Error('The API returned invalid participants.');
  return { ...activity, participants: activity.participants };
}
export function parseList<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('The API returned an unexpected list.');
  return value.map(parse);
}
export function message(error: unknown): string { return error instanceof Error ? error.message : 'Could not connect. Please retry.'; }
export function stored(key: string): string { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } }
export function persist(key: string, value: string): boolean { try { localStorage.setItem(key, value); return true; } catch { return false; } }
export function journey(): string {
  const previous = stored('velio.journey.v1');
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previous) ? previous : crypto.randomUUID();
  persist('velio.journey.v1', id);
  return id;
}

export interface Booking {
  id: string; activityId: string; planId: string; userId: string; priceMinor: number; currency: string; confirmedAt: string;
}
export interface BookingState {
  booking: Booking | null;
  availability: { activityId: string; planId: string; capacity: number; confirmedCount: number; remainingSeats: number; version: number };
  telemetry?: string;
}
export function parseBookingState(value: unknown, activity: Activity, actorId: string): BookingState {
  const data = record(value);
  const available = record(data.availability);
  if (available.activityId !== activity.id || available.planId !== activity.planId ||
    !['capacity', 'confirmedCount', 'remainingSeats', 'version'].every(key => Number.isInteger(available[key])) ||
    Number(available.capacity) < 1 || Number(available.confirmedCount) < 0 || Number(available.remainingSeats) < 0 ||
    Number(available.confirmedCount) + Number(available.remainingSeats) !== available.capacity || Number(available.version) < 1) {
    throw new Error('The API returned invalid booking availability.');
  }
  if (data.booking !== null) {
    const booking = record(data.booking);
    if (typeof booking.id !== 'string' || booking.activityId !== activity.id || booking.planId !== activity.planId ||
      booking.userId !== actorId || !Number.isInteger(booking.priceMinor) || Number(booking.priceMinor) < 0 ||
      typeof booking.currency !== 'string' || typeof booking.confirmedAt !== 'string' || !Number.isFinite(Date.parse(booking.confirmedAt))) {
      throw new Error('The API returned an invalid booking confirmation.');
    }
  }
  return data as unknown as BookingState;
}
