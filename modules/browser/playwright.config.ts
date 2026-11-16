import { defineConfig, devices } from '@playwright/test';

// W15 in a real browser. Each test boots the shared e2e server (apps/web/e2e/server.ts: port 0, temp home, every
// module, the probe-capable Fake brain) and serves the built web app from apps/web/dist (build it first:
// `pnpm --filter @pasabot/web exec vite build`); no network needed.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
