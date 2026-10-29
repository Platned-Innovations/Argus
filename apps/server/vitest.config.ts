import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits decorator metadata, which Nest dependency injection needs (esbuild does not).
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    // Each e2e file starts its own database containers; running files one at a time keeps CI runners within resources.
    fileParallelism: false,
    hookTimeout: 180_000,
  },
});
