import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` runs the server on PASABOT_DEV_SERVER (default 127.0.0.1:7777); the dev web server proxies /api and /ws
// to it, so the page, the cookie and the socket share one origin (PASABOT_ALLOWED_ORIGINS lists it on the server).
const target = process.env.PASABOT_DEV_SERVER ?? 'http://127.0.0.1:7777';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PASABOT_WEB_PORT ?? 5173),
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
});
