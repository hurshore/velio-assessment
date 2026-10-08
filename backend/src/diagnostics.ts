export type FailureReporter = (context: Record<string, string>, error: unknown) => void;

export const reportFailure: FailureReporter = (context, error) => {
  const detail = error instanceof Error ? {
    name: error.name, message: redact(error.message), stack: error.stack ? redact(error.stack) : undefined,
    code: 'code' in error ? String(error.code) : undefined,
  } : { message: 'Non-Error failure' };
  console.error({ ...context, error: detail });
};

function redact(value: string): string {
  return value.replace(/(\w+:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, '$1[redacted]@');
}
