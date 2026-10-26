/// <reference types="vite/client" />

import type { MobileHistoryDiagnostics } from '@osi/history-uplot';

declare global {
  interface ImportMetaEnv {
    readonly VITE_OSI_SERVER_URL?: string;
    readonly VITE_HISTORY_UPLOT_SOIL_ENABLED?: string;
    readonly VITE_MOBILE_HISTORY_INTERNAL?: string;
    readonly VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS?: string;
    readonly VITE_BASE_PATH?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    __osiMobileHistoryDiagnostics?: MobileHistoryDiagnostics;
  }
}

export {};

declare module '*.png' {
  const src: string;
  export default src;
}
