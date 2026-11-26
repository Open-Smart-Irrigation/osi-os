import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = dirname(fileURLToPath(import.meta.url));
export const guiRoot = resolve(root, '../react-gui');
const demoRoot = resolve(guiRoot, 'demo');
const edgeRoot = resolve(root, '../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');

export const sharedConfig = {
  root,
  base: './',
  resolve: {
    alias: {
      '@osi-demo': demoRoot,
      '@osi-edge': edgeRoot,
    },
  },
  server: {
    fs: {allow: [root, demoRoot, edgeRoot, guiRoot]},
  },
};

/** @returns {import('vite').Plugin} */
export function cjsEdge() {
  return {
    name: 'cjs-edge',
    enforce: 'pre',
    transform(code, id) {
      if (relative(edgeRoot, id) !== 'osi-agronomy-daily/et0.js') return;

      // This edge file is self-contained and exports an object of named functions.
      const exports = /\bmodule\.exports\s*=\s*\{\s*([\w\s,]+)\}\s*;?\s*$/.exec(code)?.[1];
      if (!exports) this.error('Expected named CommonJS exports in osi-agronomy-daily/et0.js');
      const names = exports.split(',').map((name) => name.trim()).filter(Boolean);
      return {
        code: `const edgeExports = (() => {
          const module = {exports: {}};
          ${code}
          return module.exports;
        })();
        export const {${names.join(', ')}} = edgeExports;`,
        map: null,
      };
    },
  };
}

const phonePolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; "
  + "base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'";
const gamePolicy = phonePolicy.replace(/\b(connect|frame|worker)-src 'none'/g, "$1-src 'self'");

/** @param {'game' | 'phone'} entry @returns {import('vite').Plugin} */
export function contentSecurityPolicy(entry) {
  const policy = entry === 'phone' ? phonePolicy : gamePolicy;
  return {
    name: 'farm-sim-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [{
          tag: 'meta',
          attrs: {'http-equiv': 'Content-Security-Policy', content: policy},
          injectTo: 'head-prepend',
        }];
      },
    },
  };
}

export function productionHeaders(phone) {
  return {
    'Content-Security-Policy': (phone ? phonePolicy : gamePolicy) + "; frame-ancestors 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  };
}

/** @param {'game' | 'phone'} entry @returns {import('vite').Plugin} */
export function previewContentSecurityPolicy(entry) {
  return {
    name: 'farm-sim-preview-csp',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?', 1)[0] ?? '';
        const phone = entry === 'phone' || /(?:^|\/)phone\/phone\.html$/.test(pathname);
        for (const [name, value] of Object.entries(productionHeaders(phone))) res.setHeader(name, value);
        next();
      });
    },
  };
}

export function isWithin(directory, file) {
  const child = relative(directory, file);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}
