import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig({
  base: '/', publicDir: false,
  plugins: [{name: 'demo-local-translations', enforce: 'pre', resolveId(source) {
    if (/(?:^|\/)i18n\/config(?:\.ts)?$/.test(source)) return resolve('demo/i18n.ts');
  }}, react()],
  build: {outDir: 'demo-build', target: 'esnext', rollupOptions: {input: {slide: resolve('demo/index.html'), app: resolve('demo/app.html'), reveal: resolve('demo/reveal.html')}}},
});
