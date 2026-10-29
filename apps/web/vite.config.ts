import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * sonner injects its stylesheet at runtime through a <style> element, which the Content-Security-Policy
 * (style-src 'self') blocks. The same stylesheet is imported in main.tsx and bundled, so the injection is removed.
 * The build fails if a sonner upgrade changes it, rather than silently loosening or breaking the policy.
 */
function sonnerWithoutInlineCss(): Plugin {
  return {
    name: 'argus:sonner-without-inline-css',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.m?js$/.test(id)) return null;
      const out = code.replace(/^__insertCSS\(/m, 'void (');
      if (out === code) this.error('sonner no longer injects CSS with __insertCSS; review the CSP workaround in vite.config.ts.');
      return { code: out, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiTarget =
    process.env.ARGUS_API_URL ?? env.ARGUS_API_URL ?? `http://localhost:${env.PORT ?? 8080}`;

  return {
  plugins: [sonnerWithoutInlineCss(), react(), tailwindcss()],
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
