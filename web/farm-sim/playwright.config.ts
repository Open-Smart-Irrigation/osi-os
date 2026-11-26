import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 90_000,
  workers: 2,
  reporter: [['list'], ['json', {outputFile: 'test-results/e2e.json'}]],
  outputDir: 'test-results/playwright',
  use: {
    baseURL: 'http://127.0.0.1:4275/',
    viewport: {width: 430, height: 900},
    browserName: 'chromium',
    actionTimeout: 5000,
    launchOptions: {args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']},
  },
  // The perf spec measures main-thread time (plan section 12), so it runs after the other specs,
  // when no second worker shares the CPU.
  projects: [
    {name: 'e2e', testIgnore: /perf\.spec\.ts$/},
    {name: 'perf', testMatch: /perf\.spec\.ts$/, dependencies: ['e2e']},
  ],
  webServer: {
    command: 'node tests/e2e/serve.mjs',
    url: 'http://127.0.0.1:4275/phone-host.html',
    reuseExistingServer: false,
  },
});
