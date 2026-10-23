/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSI_SERVER_URL?: string;
  readonly VITE_HISTORY_UPLOT_SOIL_ENABLED?: string;
  readonly VITE_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.png' {
  const src: string;
  export default src;
}
