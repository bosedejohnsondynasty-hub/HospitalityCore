import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:4000';
// Exactly the hosts this deployment is served under; never a blanket wildcard.
// The Freebuff preview proxy hostname is added here for local preview testing.
const previewHost =
  'pv-3d8bcf9d0591-8fc23acc-652a-43ad-abe4-1b244e2267f8.style.dev';
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const effectiveAllowedHosts = allowedHosts.length > 0
  ? [...new Set([...allowedHosts, previewHost])]
  : [previewHost];

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
    strictPort: true,
    allowedHosts: effectiveAllowedHosts,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
  },
  build: { outDir: 'dist', sourcemap: false },
});
