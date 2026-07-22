import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'ui/src/**/*.test.ts', 'ui/src/**/*.test.tsx'],
  },
});
