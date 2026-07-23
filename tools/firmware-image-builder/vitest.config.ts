import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    include: ['test/**/*.test.ts', 'ui/src/**/*.test.ts', 'ui/src/**/*.test.tsx'],
  },
});
