import { defineConfig, mergeConfig } from 'vite';
import releaseConfig from './vite.config.js';

export default defineConfig(mergeConfig(releaseConfig, {
  define: { __OSI_INTERNAL_PHONE_CHARTS__: true },
  build: { outDir: 'build-mobile-history-internal' },
}));
