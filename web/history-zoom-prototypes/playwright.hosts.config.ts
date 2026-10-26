import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/hosts',
  outputDir: './test-results/hosts',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    trace: 'retain-on-failure',
    launchOptions: { args: ['--disable-gpu', '--disable-dev-shm-usage'] },
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: 'en',
  },
  projects: [
    { name: 'edge', use: { baseURL: process.env.EDGE_HISTORY_BASE_URL || 'http://127.0.0.1:3000' } },
    { name: 'cloud', use: { baseURL: process.env.CLOUD_HISTORY_BASE_URL || 'http://127.0.0.1:3000' } },
  ],
  reporter: [['list']],
});
