import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {
  cjsEdge, contentSecurityPolicy, guiRoot, isWithin, previewContentSecurityPolicy, root, sharedConfig,
} from './vite.shared.mjs';

const requireGui = createRequire(resolve(guiRoot, 'package.json'));
const react = requireGui('@vitejs/plugin-react');
const tailwind = requireGui('@tailwindcss/postcss');
const autoprefixer = requireGui('autoprefixer');
const phoneRoot = resolve(root, 'src/phone');
const guiImporter = resolve(guiRoot, 'src/main.jsx');

function phoneAliases() {
  const datetime = resolve(guiRoot, 'demo/public/datetime.ts');
  const demoDatetime = resolve(guiRoot, 'demo/datetime.ts');
  return {
    name: 'farm-sim-phone-aliases',
    enforce: 'pre',
    resolveId(source, importer) {
      if (/(?:^|\/)utils\/datetime(?:\.ts)?$/.test(source) && importer !== datetime && importer !== demoDatetime) {
        return datetime;
      }
      if (source === 'react-leaflet' && importer === resolve(guiRoot, 'src/pages/NetworkPage.tsx')) {
        return resolve(guiRoot, 'demo/public/offline-map.tsx');
      }
      if (/(?:^|\/)services\/deviceLocation(?:\.ts)?$/.test(source)) {
        return resolve(phoneRoot, 'device-location.ts');
      }
      if (/(?:^|\/)i18n\/config(?:\.ts)?$/.test(source)) {
        return resolve(guiRoot, 'demo/i18n.ts');
      }
    },
  };
}

function phoneBareImports() {
  return {
    name: 'farm-sim-phone-bare-imports',
    enforce: 'pre',
    config: {
      order: 'post',
      handler(config) {
        // plugin-react assumes React is installed in Vite's project root.
        config.resolve.dedupe = config.resolve.dedupe.filter(
          (name) => name !== 'react' && name !== 'react-dom',
        );
        config.optimizeDeps.include = config.optimizeDeps.include.filter(
          (id) => !/^(?:react|react-dom)(?:\/|$)/.test(id),
        );
      },
    },
    resolveId(source, importer) {
      if (importer && isWithin(phoneRoot, importer) && /^(?:@[\w.-]+\/)?[\w-][\w.-]*(?:\/|$)/.test(source)) {
        return this.resolve(source, guiImporter, {skipSelf: true});
      }
    },
  };
}

function singlePhonePackages() {
  const packages = new Set(['react', 'react-dom', 'swr', 'i18next', 'react-i18next']);
  return {
    name: 'farm-sim-phone-single-packages',
    generateBundle(_options, bundle) {
      const roots = new Map();
      const modules = new Map();

      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          // Rollup also lists virtual CommonJS helpers alongside the real modules.
          if (id.startsWith('\0')) continue;
          const file = id.split('?', 1)[0];
          const modulesDir = file.lastIndexOf('/node_modules/');
          if (modulesDir < 0) continue;
          const packageName = file.slice(modulesDir + '/node_modules/'.length).split('/', 1)[0];
          if (!packages.has(packageName)) continue;

          const packageRoot = file.slice(0, modulesDir + '/node_modules/'.length) + packageName;
          const previousRoot = roots.get(packageName);
          if (previousRoot && previousRoot !== packageRoot) {
            this.error(`Duplicate ${packageName} package roots: ${previousRoot}, ${packageRoot}`);
          }
          roots.set(packageName, packageRoot);

          if (!/\.(?:js|mjs|cjs)$/.test(file)) continue;
          const stem = file.replace(/\.(?:js|mjs|cjs)$/, '');
          const previousFile = modules.get(stem);
          if (previousFile && previousFile !== file) {
            this.error(`Duplicate ${packageName} module formats: ${previousFile}, ${file}`);
          }
          modules.set(stem, file);
        }
      }

      this.info(`Duplicate-package check passed (${roots.size} tracked packages in the bundle)`);
    },
  };
}

export default {
  ...sharedConfig,
  publicDir: false,
  define: {
    'import.meta.env.VITE_PUBLIC_SIMULATOR': JSON.stringify('true'),
    'import.meta.env.VITE_OSI_SERVER_URL': JSON.stringify('https://cloud.example.test'),
    __OSI_INTERNAL_PHONE_CHARTS__: false,
  },
  css: {postcss: {plugins: [tailwind({base: resolve(guiRoot, 'src')}), autoprefixer()]}},
  plugins: [
    phoneAliases(),
    phoneBareImports(),
    cjsEdge(),
    react({jsxImportSource: 'react'}),
    singlePhonePackages(),
    contentSecurityPolicy('phone'),
    previewContentSecurityPolicy('phone'),
  ],
  build: {
    outDir: 'dist/phone',
    emptyOutDir: true,
    target: 'esnext',
    modulePreload: {polyfill: false},
    rollupOptions: {input: resolve(root, 'phone.html')},
  },
};
