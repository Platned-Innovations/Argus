import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiTarget =
    process.env.ARGUS_API_URL ?? env.ARGUS_API_URL ?? `http://localhost:${env.PORT ?? 8080}`;

  return {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Consume the shared package from source so the SPA bundles it as ESM.
      '@argus/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/healthz': apiTarget,
      '/readyz': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  };
});
