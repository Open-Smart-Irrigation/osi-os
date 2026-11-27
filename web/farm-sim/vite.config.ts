import {resolve} from 'node:path';
import {defineConfig, type UserConfig} from 'vite';
import {cjsEdge, contentSecurityPolicy, previewContentSecurityPolicy, root, sharedConfig} from './vite.shared.mjs';

export default defineConfig(({mode}): UserConfig => {
  const smokeHost = mode === 'phone-smoke';
  return {
    ...sharedConfig,
    publicDir: smokeHost ? false : undefined,
    plugins: [cjsEdge(), contentSecurityPolicy('game'), previewContentSecurityPolicy('game')],
    build: {
      outDir: smokeHost ? 'test-results/phone-host' : 'dist',
      emptyOutDir: true,
      assetsInlineLimit: 0,
      ...(smokeHost && {
        assetsDir: 'phone-host-assets',
        rollupOptions: {input: resolve(root, 'phone-host.html')},
      }),
    },
  };
});
