import { defineConfig } from 'vitest/config';
import releaseConfig from './vite.config.js';

export default defineConfig({
    define: releaseConfig.define,
    resolve: { dedupe: ['react', 'react-dom'] },
    test: {
        globals: true,
        environment: 'jsdom',
    },
});
