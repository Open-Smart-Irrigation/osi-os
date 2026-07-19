import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        // Scope discovery to src so every __tests__ subdir is picked up automatically
        // (a hand-maintained directory list previously omitted journal/desktop and
        // journal/markers). The top-level tests/ suite stays with the tsx --test runner.
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
});
