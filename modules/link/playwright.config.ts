import { defineConfig, devices } from '@playwright/test';

// W28 in a real browser: two servers linked over the in-memory transport (e2e/server.ts), the built web app from
// apps/web/dist; no network needed.
export default defineConfig({
  testDir: './e2e',
  // two servers, two owners, two password confirmations: generous under the full e2e run's load
  timeout: 150_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: false,
      },
    },
  ],
});
