/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_SIMULATOR: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
