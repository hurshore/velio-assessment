import type { Activity } from './api';
export function displayTime(startsAt: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(new Date(startsAt));
}
export function activityStatus(activity: Activity): string {
  if (activity.status === 'cancelled') return 'Cancelled';
  if (activity.status !== 'scheduled' || Date.parse(activity.startsAt) <= Date.now()) return 'Started';
  return activity.remainingSeats === 0 ? 'Full' : `${activity.remainingSeats} ${activity.remainingSeats === 1 ? 'spot' : 'spots'} left`;
}
export function priceToMinor(value: string, currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf('currency').includes(currency)) throw new Error('Choose a supported three-letter currency code.');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > digits) throw new Error(`Enter a non-negative price with at most ${digits} decimal places for ${currency}.`);
  const minor = BigInt(match[1]!) * 10n ** BigInt(digits) + BigInt((match[2] ?? '').padEnd(digits, '0') || '0');
  if (minor > 2147483647n) throw new Error('This price is too large.');
  return Number(minor);
}
