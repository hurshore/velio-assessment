// Local tooling derives its target from PORT unless a device/network URL is explicit.
export const defaultApiPort = 3000;

export function apiPort(env) {
  const port = Number(env.PORT ?? defaultApiPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}

export function httpOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) origin`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

export function localApiBase(env) {
  return httpOrigin(env.API_BASE_URL ?? `http://127.0.0.1:${apiPort(env)}`, 'API_BASE_URL');
}
