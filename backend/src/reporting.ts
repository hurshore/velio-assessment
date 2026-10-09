import { DomainError } from './domain.js';
import { defaultReportingWindowMs, maxReportingWindowMs } from './live-policy.js';

export interface ReportingWindow { includeTest: boolean; from: Date; to: Date }

// Shared by every metrics endpoint so windows, marker filtering and limits cannot drift.
// Defaults follow the live report: the preceding 24 hours, at most seven days.
export function parseReportingWindow(query: Record<string, unknown>): ReportingWindow {
  if (query.includeTest !== undefined && (typeof query.includeTest !== 'string' || !['true', 'false'].includes(query.includeTest))) {
    throw new DomainError(400, 'INVALID_REQUEST', 'includeTest must be true or false.');
  }
  const includeTest = query.includeTest === 'true';
  const to = query.to === undefined ? new Date() : timestamp(query.to);
  const from = query.from === undefined ? new Date(to.getTime() - defaultReportingWindowMs) : timestamp(query.from);
  if (to <= from || to.getTime() - from.getTime() > maxReportingWindowMs) {
    throw new DomainError(400, 'INVALID_REQUEST', 'Reporting window must be positive and at most seven days.');
  }
  return { includeTest, from, to };
}

function timestamp(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DomainError(400, 'INVALID_REQUEST', 'Window timestamps must be ISO timestamps with timezone.');
  }
  return new Date(value);
}
