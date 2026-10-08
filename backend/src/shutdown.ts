import { reportFailure, type FailureReporter } from './diagnostics.js';

const shutdownTimeoutMs = 5000;

export function createShutdown(resources: Record<'http' | 'redis' | 'postgres', () => Promise<void>>, logFailure: FailureReporter = reportFailure) {
  let pending: Promise<number> | undefined;
  return (exitCode = 0): Promise<number> => {
    if (pending) return pending;
    pending = (async () => {
      const deadline = setTimeout(() => process.exit(1), shutdownTimeoutMs);
      deadline.unref();
      let outcome = exitCode;
      try {
        for (const [name, close] of Object.entries(resources)) {
          try { await close(); }
          catch (error) { outcome = 1; logFailure({ component: `shutdown.${name}` }, error); }
        }
        return outcome;
      } finally { clearTimeout(deadline); }
    })();
    return pending;
  };
}
