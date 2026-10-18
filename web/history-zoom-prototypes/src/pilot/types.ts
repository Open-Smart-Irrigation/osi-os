import type { SensorSeries, Viewport } from "../shared/types";

export type PilotPlatform = "edge" | "cloud";
export type PilotAggregation = "raw" | "15m" | "hourly" | "daily";
export interface PilotZone {
  id: number;
  name: string;
}
export interface PilotCard {
  cardId: string;
  cardType: string;
  title: string;
  views: string[];
  sourceLabels: string[];
  available: boolean;
}
export interface PilotRangeRequest {
  from: number;
  to: number;
  rangeLabel: "24h" | "7d" | "30d";
  aggregation: PilotAggregation;
}
export interface PilotAcceptedData {
  cardId: string;
  request: PilotRangeRequest;
  coverage: { from: number; to: number };
  series: readonly SensorSeries[];
  unitGroups: readonly {
    unit: string;
    label: string;
    seriesIds: readonly string[];
  }[];
  aggregation: { level: string; pointCount: number };
  limits: { maxPointsPerSeries: number; truncated: boolean };
}
export interface PilotHistoryContext {
  platform: PilotPlatform;
  sessionEpoch: number;
  zoneId: number;
  cardId: string;
}
export type PilotHistoryReason =
  | "initial"
  | "gesture"
  | "preset"
  | "back"
  | "forward"
  | "latest"
  | "retry"
  | "visibility"
  | "prefetch";
export interface PilotHistoryDemand {
  context: PilotHistoryContext;
  visible: Viewport;
  request: PilotRangeRequest;
  horizon: Viewport;
  reason: PilotHistoryReason;
  forceFresh: boolean;
  direction?: "back" | "forward";
}
export interface PilotHistoryLoadValue {
  data: PilotAcceptedData;
  receivedAt: number;
}
export interface PilotHistoryLoadHandle {
  source: "cache" | "network" | "in-flight";
  request: PilotRangeRequest;
  result: Promise<PilotHistoryLoadValue>;
}
export class PilotHistoryAbortError extends Error {
  readonly name = "AbortError" as const;
  constructor(readonly reason: "superseded" | "cleared" | "destroyed") {
    super(`History request aborted: ${reason}`);
  }
}
export interface PilotHistoryLoader {
  foreground(
    demand: PilotHistoryDemand,
    load: (signal: AbortSignal) => Promise<PilotAcceptedData>,
  ): PilotHistoryLoadHandle;
  prefetch(
    demand: PilotHistoryDemand,
    load: (signal: AbortSignal) => Promise<PilotAcceptedData>,
  ): Promise<"cached" | "joined" | "skipped">;
  abortPrefetch(): void;
  clear(): void;
  destroy(): void;
  diagnostics(): {
    entries: number;
    points: number;
    foregroundActive: boolean;
    prefetchActive: boolean;
  };
}
export interface PilotPlatformConfig {
  historyPrefix: "/api/history" | "/api/v1/history";
  zonesPath: "/api/irrigation-zones" | "/api/v1/irrigation-zones";
  loginPath: "/gui/#/login" | "/login";
}
export interface PilotApiDependencies {
  fetchImpl?: typeof fetch;
  origin?: string;
}
export interface PilotAuthInput {
  token: string;
  signal: AbortSignal;
}
export interface PilotApi {
  getZones(input: PilotAuthInput): Promise<PilotZone[]>;
  getCards(input: PilotAuthInput & { zoneId: number }): Promise<PilotCard[]>;
  getCardData(
    input: PilotAuthInput & {
      zoneId: number;
      cardId: string;
      view: "line-chart";
      request: PilotRangeRequest;
    },
  ): Promise<PilotAcceptedData>;
}
export class PilotAuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "PilotAuthError";
    this.status = status;
  }
}
export class PilotHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PilotHttpError";
    this.status = status;
  }
}
export class PilotResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PilotResponseError";
  }
}
export type PilotRunResult =
  | "applied"
  | "superseded"
  | "cancelled"
  | "auth-required";
export interface PilotRequestOwner {
  readonly sessionEpoch: number;
  run<T>(input: {
    load(signal: AbortSignal, token: string): Promise<T>;
    apply(value: T): void;
  }): Promise<PilotRunResult>;
  cancel(): boolean;
  destroy(): void;
}
export type { SensorSeries, Viewport };
