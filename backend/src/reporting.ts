import { DomainError, type Database } from './domain.js';
import type { BookingDatabase } from './bookings.js';
import { defaultReportingWindowMs, maxReportingWindowMs } from './live-policy.js';
import { dependencyTimeoutMs } from './readiness.js';

export interface ReportingWindow { includeTest: boolean; from: Date; to: Date }

// Shared by every metrics endpoint so windows and limits cannot drift. Defaults follow the
// live report: the preceding 24 hours, at most seven days.
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

// Window queries bind $1 includeTest, $2 from and $3 to, in that order.
export function windowParameters({ includeTest, from, to }: ReportingWindow): unknown[] {
  return [includeTest, from.toISOString(), to.toISOString()];
}

// The one synthetic/test exclusion: a fact is excluded when any participating row carries a
// server-derived marker. Pass each table alias whose markers apply; '' means unqualified columns.
export function unmarked(...aliases: string[]): string {
  const markers = aliases.map(alias => {
    if (alias && !/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Marker SQL alias must be a simple identifier.');
    const prefix = alias ? `${alias}.` : '';
    return `${prefix}synthetic OR ${prefix}test`;
  });
  return `($1 OR NOT (${markers.join(' OR ')}))`;
}

function timestamp(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DomainError(400, 'INVALID_REQUEST', 'Window timestamps must be ISO timestamps with timezone.');
  }
  return new Date(value);
}

// Reports share the booking pool, so each one runs its queries sequentially on a single
// connection inside one read-only REPEATABLE READ snapshot (every block sees the same data),
// with each statement bounded by the driver's dependency timeout. At most two reports hold a
// connection at once; others wait their turn rather than fanning out across the pool.
export const maxConcurrentReports = 2;
let activeReports = 0;
const waiting: (() => void)[] = [];

async function reportSlot(): Promise<() => void> {
  if (activeReports >= maxConcurrentReports) await new Promise<void>(resolve => waiting.push(resolve));
  else activeReports++;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else activeReports--;
  };
}

export async function withReportSnapshot<T>(db: BookingDatabase, run: (snapshot: Database) => Promise<T>): Promise<T> {
  const release = await reportSlot();
  try {
    if (!db.connect) return await run(db);
    const connection = await db.connect();
    let discard = false;
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await connection.query(`SET LOCAL statement_timeout = '${dependencyTimeoutMs}ms'`);
      const result = await run(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try { await connection.query('ROLLBACK'); }
      catch { discard = true; }
      throw error;
    } finally {
      connection.release(discard);
    }
  } finally {
    release();
  }
}
