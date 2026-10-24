import { defineConfig, devices } from '@playwright/test';

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? '4000';
const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? '3000';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @payment/api dev',
      url: `http://localhost:${apiPort}/health/live`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { PAYMENT_GATEWAY: 'mock' },
    },
    {
      command: 'cmd /c "pnpm exec next dev --port 3000 --webpack || pnpm exec next dev --port 3000 --webpack"',
      url: `http://localhost:${webPort}`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { API_URL: `http://localhost:${apiPort}` },
    },
  ],
});
