/// <reference types="vite/client" />

import type { MobileHistoryDiagnostics } from '@osi/history-uplot';

declare global {
  const __OSI_INTERNAL_PHONE_CHARTS__: boolean;

  interface ImportMetaEnv {
    readonly VITE_OSI_SERVER_URL?: string;
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
