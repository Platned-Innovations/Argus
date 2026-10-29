import { defineConfig, devices } from '@playwright/test';

export const PORT = Number(process.env.ARGUS_E2E_PORT ?? 18765);

/**
 * Browser tests run the built server (with the built web app) against a fresh PostgreSQL container and a mock
 * GitHub. Build first: `npm run build` at the repository root (or use `npm run test:browser`).
 */
export default defineConfig({
  testDir: './tests',
  // The tests share one installation and build on each other (first sign-in, then a source, then its tickets).
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
