import { defineConfig, devices } from '@playwright/test';

// W13 in a real browser. Each test boots the shared e2e server (apps/web/e2e/server.ts: port 0, temp home, every
// module, the Fake brain with `{"probe": …}`) and the built web app from apps/web/dist; no network needed.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
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
