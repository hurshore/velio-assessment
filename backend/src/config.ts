function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run npm run setup`);
  return value;
}

export function loadConfig() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return {
    port,
    host: process.env.HOST ?? '0.0.0.0',
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
  };
}
