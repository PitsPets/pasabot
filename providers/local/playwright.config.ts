import { defineConfig, devices } from '@playwright/test';

// W34 in a real browser at 1440 and 390 px. Each test boots its own server (e2e/server.ts: port 0, temp home, a stub
// Ollama on 127.0.0.1 port 0) and serves the built web app from apps/web/dist; no network, no real Ollama.
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
