import { isRecord, parseEnvelope, unexpectedResponseMessage } from './response-envelope';
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export interface Identity {
  id: string; displayName: string; generation: number; acquisitionParentId: string | null; acquisitionRootId: string;
  acquisitionRail: 'public' | 'vouch' | null; synthetic: boolean; test: boolean;
}
export type PolicyReason = 'allowed' | 'creation_disabled' | 'control' | 'host_or_booker_required' | 'assignment_unavailable';
export interface InviteState { creationEnabled: boolean; allowed: boolean; reason: PolicyReason }
export interface Assignment { experiment: 'group_invites_v1'; version: string; treatmentPercent: number; variant: 'treatment' | 'control'; assignedAt: string }
export interface Activity {
  id: string; hostId: string; title: string; description: string; meetingLocation: string; startsAt: string; timezone: string;
  capacity: number; confirmedCount: number; remainingSeats: number; priceMinor: number; currency: string; version: number;
  invitePolicy?: InviteState; assignment?: Assignment | null; status: string; planId: string; participants?: { id: string; displayName: string }[];
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
    (data.acquisitionRail !== null && data.acquisitionRail !== 'public' && data.acquisitionRail !== 'vouch') ||
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
export type ActivityDetail = Activity & { participants: NonNullable<Activity['participants']>; invitation: { assignment: Assignment | null; policy: InviteState } };
export function parseActivityDetail(value: unknown): ActivityDetail {
  const activity = parseActivity(value);
  if (!activity.participants) throw new Error('The API returned invalid participants.');
  let invitation: ActivityDetail['invitation'];
  try { invitation = parseInvitation(record(value)); }
  catch {
    invitation = { assignment: null, policy: { creationEnabled: false, allowed: false, reason: 'assignment_unavailable' } };
  }
  return { ...activity, assignment: invitation.assignment, invitePolicy: invitation.policy, participants: activity.participants, invitation };
}
function parseInvitation(data: Record<string, unknown>): ActivityDetail['invitation'] {
  const raw = data.assignment;
  let assignment: Assignment | null = null;
  if (raw !== null) {
    const a = record(raw);
    if (a.experiment !== 'group_invites_v1' || typeof a.version !== 'string' || !a.version.trim() || a.version.length > 100 ||
      !Number.isInteger(a.treatmentPercent) || Number(a.treatmentPercent) < 0 || Number(a.treatmentPercent) > 100 ||
      (a.variant !== 'treatment' && a.variant !== 'control') || typeof a.assignedAt !== 'string' || !Number.isFinite(Date.parse(a.assignedAt))) {
      throw new Error('Invalid invitation assignment.');
    }
    assignment = a as unknown as Assignment;
  }
  const p = record(data.invitePolicy);
  if (typeof p.creationEnabled !== 'boolean' || typeof p.allowed !== 'boolean' ||
    (p.reason !== 'allowed' && p.reason !== 'creation_disabled' && p.reason !== 'control' && p.reason !== 'host_or_booker_required' && p.reason !== 'assignment_unavailable') ||
    p.allowed !== (p.reason === 'allowed')) throw new Error('Invalid invitation policy.');
  let consistent: boolean;
  if (!assignment) consistent = p.reason === 'assignment_unavailable';
  else if (!p.creationEnabled) consistent = p.reason === 'creation_disabled';
  else if (assignment.variant === 'control') consistent = p.reason === 'control';
  else consistent = p.reason === 'allowed' || p.reason === 'host_or_booker_required';
  if (!consistent) throw new Error('Invitation policy contradicts assignment or switch.');
  return { assignment, policy: p as unknown as InviteState };
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

export interface CreatedInvite {
  id: string; code: string; rail: 'public'; inviterRole: 'host' | 'booker'; activityId: string; planId: string; createdAt: string; expiresAt: string;
  availability: { capacity: number; confirmedCount: number; remainingSeats: number; version: number };
}
const codePattern = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const unexpectedInvite = 'The API returned an unexpected invitation.';
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function seatCounts(data: Record<string, unknown>): boolean {
  return ['capacity', 'confirmedCount', 'remainingSeats', 'version'].every(key => Number.isInteger(data[key])) &&
    Number(data.capacity) >= 1 && Number(data.confirmedCount) >= 0 && Number(data.remainingSeats) >= 0 && Number(data.version) >= 1 &&
    Number(data.confirmedCount) + Number(data.remainingSeats) === data.capacity;
}
export function parseCreatedInvite(value: unknown, activity: Pick<Activity, 'id' | 'planId'>): CreatedInvite {
  const data = record(value);
  if (typeof data.id !== 'string' || typeof data.code !== 'string' || !codePattern.test(data.code) || data.rail !== 'public' ||
    (data.inviterRole !== 'host' && data.inviterRole !== 'booker') || data.activityId !== activity.id || data.planId !== activity.planId ||
    !timestamp(data.createdAt) || !timestamp(data.expiresAt) || Date.parse(data.expiresAt) <= Date.parse(data.createdAt) ||
    !isRecord(data.availability) || !seatCounts(data.availability)) {
    throw new Error(unexpectedInvite);
  }
  return data as unknown as CreatedInvite;
}
// Mirrors the server's normalization so typed or pasted codes resolve the same invite.
export function normalizeInviteCode(value: string): string { return value.replace(/[\s-]/g, '').toUpperCase(); }
export function isInviteCode(value: string): boolean { return codePattern.test(normalizeInviteCode(value)); }
export function groupedCode(code: string): string { return code.match(/.{1,4}/g)!.join('-'); }
export function inviteLink(code: string): string { return `${window.location.origin}/invite/${code}`; }
// Documented installed-app route, to be registered by the Flutter guest app (#8). The journey lets
// an app claim continue this browser's guest journey instead of starting an unlinked one.
export function appLink(code: string, journeyId: string): string { return `velio://invite/${code}?journey=${journeyId}`; }

const previewStates = ['valid', 'full', 'expired', 'started', 'cancelled'] as const;
export type PreviewState = typeof previewStates[number];
// The public preview's activity: no host identifier, policy or participants are exposed to guests.
export interface PreviewActivity {
  id: string; planId: string; title: string; description: string; meetingLocation: string; startsAt: string; timezone: string; status: string;
  capacity: number; confirmedCount: number; remainingSeats: number; priceMinor: number; currency: string; version: number;
}
export interface InvitePreview {
  code: string; rail: 'public'; trust: 'public'; state: PreviewState; createdAt: string; expiresAt: string;
  inviter: { displayName: string; role: 'host' | 'booker' }; activity: PreviewActivity;
}
function parsePreviewActivity(value: unknown): PreviewActivity {
  const data = record(value);
  if (!['id', 'planId', 'title', 'description', 'meetingLocation', 'timezone', 'status', 'currency'].every(key => typeof data[key] === 'string') ||
    !timestamp(data.startsAt) || !seatCounts(data) || !Number.isInteger(data.priceMinor) || Number(data.priceMinor) < 0) throw new Error(unexpectedInvite);
  try { new Intl.DateTimeFormat('en', { timeZone: data.timezone as string }); }
  catch { throw new Error(unexpectedInvite); }
  return data as unknown as PreviewActivity;
}
export function parseInvitePreview(value: unknown): InvitePreview {
  const data = record(value);
  const inviter = record(data.inviter);
  if (typeof data.code !== 'string' || !codePattern.test(data.code) || data.rail !== 'public' || data.trust !== 'public' ||
    !previewStates.includes(data.state as PreviewState) || !timestamp(data.createdAt) || !timestamp(data.expiresAt) ||
    typeof inviter.displayName !== 'string' || !inviter.displayName.trim() || (inviter.role !== 'host' && inviter.role !== 'booker')) {
    throw new Error(unexpectedInvite);
  }
  return { ...(data as unknown as InvitePreview), activity: parsePreviewActivity(data.activity) };
}
export function formatPrice(minor: number, currency: string): string {
  if (minor === 0) return 'Free';
  try {
    const format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return `${minor} ${currency} minor units`; }
}
