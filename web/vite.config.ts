import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { localApiBase } from '../scripts/local-api.mjs';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, fileURLToPath(new URL('../', import.meta.url)), ''), ...process.env };
  return {
    plugins: [react()],
    server: {
      host: env.WEB_HOST ?? '127.0.0.1', port: 5173, strictPort: true,
      proxy: { '/api': localApiBase(env) },
    },
    test: { environment: 'jsdom' },
  };
});
