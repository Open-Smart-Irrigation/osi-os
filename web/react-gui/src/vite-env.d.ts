/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSI_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.png' {
  const src: string;
  export default src;
}
