import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';

export function datetimeAlias(mode: string): string {
  return resolve(mode === 'public' ? 'demo/public/datetime.ts' : 'demo/datetime.ts');
}

export function createDemoViteConfig(mode: string) {
  const publicMode = mode === 'public';
  const datetimeAliases = [datetimeAlias('presentation'), datetimeAlias('public')];
  return {
    root: publicMode ? resolve('demo/public') : undefined,
    base: publicMode ? '/simulator/' : '/',
    publicDir: false,
    define: {'import.meta.env.VITE_PUBLIC_SIMULATOR': JSON.stringify(String(publicMode))},
    plugins: [{name: 'demo-local-translations', enforce: 'pre', resolveId(source, importer) {
      if (/(?:^|\/)utils\/datetime(?:\.ts)?$/.test(source) && !datetimeAliases.includes(importer ?? '')) {
        return resolve(publicMode ? 'demo/public/datetime.ts' : 'demo/datetime.ts');
      }
      if (publicMode && source === 'react-leaflet' && importer?.endsWith('/src/pages/NetworkPage.tsx')) {
        return resolve('demo/public/offline-map.tsx');
      }
      if (publicMode && /(?:^|\/)services\/deviceLocation(?:\.ts)?$/.test(source)) {
        return resolve('demo/public/device-location.ts');
      }
      if (/(?:^|\/)i18n\/config(?:\.ts)?$/.test(source)) return resolve('demo/i18n.ts');
    }}, react()],
    build: {
      outDir: publicMode ? resolve('public-demo-build') : 'demo-build',
      emptyOutDir: true,
      target: 'esnext',
      assetsDir: 'assets',
      rollupOptions: {input: publicMode
        ? {index: resolve('demo/public/index.html'), app: resolve('demo/public/app.html')}
        : {slide: resolve('demo/index.html'), app: resolve('demo/app.html'), reveal: resolve('demo/reveal.html')}},
    },
  };
}

export default defineConfig(({mode}) => createDemoViteConfig(mode));
