import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/conditional-irrigation.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: './test-results/conditional-irrigation',
  reporter: [['list'], ['json', { outputFile: './test-results/conditional-irrigation.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4181',
    ...devices['Desktop Chrome'],
    hasTouch: true,
    trace: 'retain-on-failure',
    video: 'off',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4181',
    url: 'http://127.0.0.1:4181/gui/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
