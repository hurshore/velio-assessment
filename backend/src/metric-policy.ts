import { maxReportDetails } from './live-policy.js';

// PLANS.md §4.2 targets and improvement triggers. Calculations, statuses and the reported
// target/trigger fields all read these, so a changed threshold cannot drift between them.
export const reliabilityTarget = 0.995;
export const reliabilityMinResolvedIntents = 1000;
export const bookerInviteTarget = 0.3;
export const bookerMinMatureJourneys = 200;
export const openClaimTarget = 0.25;
export const openMinMatureJourneys = 200;
export const inviteWindowHours = 24;
export const kWindowDays = 7;
export const formedPlanMinParticipants = 2;
// A claim may be recorded up to this long before its open's effective time and still convert:
// open times are client clocks, claims are server clocks. See migrations/012.
export const openClaimSkewToleranceMinutes = 5;
export const maxIntegrityDetails = maxReportDetails;
export const z95 = 1.959963984540054;

export type SampleStatus = 'no_data' | 'insufficient_sample' | 'observed';
export function sampleStatus(sample: number, trigger: number): SampleStatus {
  return !sample ? 'no_data' : sample < trigger ? 'insufficient_sample' : 'observed';
}

// Wilson score interval: bounds stay inside [0,1] for small samples. Callers guard total > 0.
export function wilson95(successes: number, total: number): [number, number] {
  if (total <= 0) throw new RangeError('A Wilson interval needs a positive sample.');
  const z2 = z95 * z95;
  const p = successes / total;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const spread = (z95 * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total))) / denominator;
  return [center - spread, center + spread];
}
