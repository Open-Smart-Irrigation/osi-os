/// <reference types="vite/client" />

import type { HistoryZoomProbe } from './shared/types';
declare global {
  interface Window { __historyZoomProbe?: HistoryZoomProbe; }
}
