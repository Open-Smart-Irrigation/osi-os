import { useEffect, useMemo, useRef, useState } from "react";
import { createPilotApi } from "./api";
import { createRequestOwner } from "./requestOwner";
import {
  createPilotHistoryLoader,
  HISTORY_PREFETCH_COOLDOWN_MS,
  HISTORY_PREFETCH_IDLE_MS,
  HISTORY_LATEST_TTL_MS,
  HISTORY_SETTLE_MS,
} from "./historyLoader";
import {
  bufferedRequest,
  coverageContains,
  HISTORY_MAX_VIEWPORT_SPAN_MS,
  HISTORY_NAVIGATION_START_MS,
  minuteViewport,
  neighborRequest,
} from "./range";
import type {
  PilotApi,
  PilotAcceptedData,
  PilotCard,
  PilotHistoryLoader,
  PilotPlatform,
  PilotRangeRequest,
  PilotZone,
} from "./types";
import {
  PilotAuthError,
  PilotHistoryAbortError,
  PilotHttpError,
  PilotResponseError,
} from "./types";
import { DAY_MS, HOUR_MS, MINUTE_MS, type Viewport } from "../shared/types";
import { createViewportStore, type ViewportStore } from "../shared/viewport";

const readBrowserToken = (): string | null => {
  try {
    return typeof window === "undefined"
      ? null
      : window.localStorage.getItem("auth_token");
  } catch {
    return null;
  }
};
const browserNow = (): number => Date.now();
export interface UsePilotHistoryOptions {
  platform: PilotPlatform;
  api?: PilotApi;
  readToken?: () => string | null;
  now?: () => number;
  historyLoader?: PilotHistoryLoader;
}
export interface UsePilotHistoryResult {
  contextKey: string;
  status: "auth-required" | "loading" | "ready" | "empty" | "error";
  zones: readonly PilotZone[];
  cards: readonly PilotCard[];
  selectedZoneId: number | null;
  selectedCardId: string | null;
  accepted: PilotAcceptedData | null;
  loadingRequest: PilotRangeRequest | null;
  error: string | null;
  failedRequest: PilotRangeRequest | null;
  refreshing: boolean;
  horizon: Viewport;
  store: ViewportStore;
  selectZone(zoneId: number): void;
  selectCard(cardId: string): void;
  selectPreset(span: "24h" | "7d" | "30d" | "90d"): void;
  moveWindow(direction: "back" | "forward"): void;
  showLatest(): void;
  retry(): void;
}
function messageFor(error: unknown): string {
  if (error instanceof PilotAuthError) return "Login required";
  if (
    error instanceof PilotHttpError ||
    error instanceof PilotResponseError ||
    error instanceof Error
  )
    return error.message;
  return "Unable to load history";
}

export function usePilotHistory({
  platform,
  api: apiOption,
  readToken = readBrowserToken,
  now = browserNow,
  historyLoader: providedLoader,
}: UsePilotHistoryOptions): UsePilotHistoryResult {
  const [sessionEpoch, setSessionEpoch] = useState(0),
    [zones, setZones] = useState<readonly PilotZone[]>([]),
    [cards, setCards] = useState<readonly PilotCard[]>([]),
    [selectedZoneId, setSelectedZoneId] = useState<number | null>(null),
    [selectedCardId, setSelectedCardId] = useState<string | null>(null),
    [accepted, setAccepted] = useState<PilotAcceptedData | null>(null),
    [loadingRequest, setLoadingRequest] = useState<PilotRangeRequest | null>(
      null,
    ),
    [status, setStatus] = useState<UsePilotHistoryResult["status"]>(
      readToken() ? "loading" : "auth-required",
    ),
    [error, setError] = useState<string | null>(null),
    [failedRequest, setFailedRequest] = useState<PilotRangeRequest | null>(
      null,
    ),
    [refreshing, setRefreshing] = useState(false),
    [retryNonce, setRetryNonce] = useState(0),
    [horizonEnd, setHorizonEnd] = useState(
      () => Math.floor(now() / MINUTE_MS) * MINUTE_MS,
    );
  const api = useMemo(
    () => apiOption ?? createPilotApi(platform),
    [platform, apiOption],
  );
  const readTokenRef = useRef(readToken);
  readTokenRef.current = readToken;
  const nowRef = useRef(now);
  nowRef.current = now;
  const owner = useMemo(
    () => createRequestOwner(() => readTokenRef.current()),
    [platform, sessionEpoch],
  );
  const defaultLoader = useMemo(
    () => createPilotHistoryLoader({ now }),
    [platform, sessionEpoch],
  );
  const loader = providedLoader ?? defaultLoader;
  const horizon = useMemo(
    () => ({ from: HISTORY_NAVIGATION_START_MS, to: horizonEnd }),
    [horizonEnd],
  );
  const identity = `${platform}:${sessionEpoch}:${selectedZoneId ?? ""}:${selectedCardId ?? ""}`;
  const visibleSpan = useRef(DAY_MS);
  const store = useMemo(() => {
    const span = Math.min(
      HISTORY_MAX_VIEWPORT_SPAN_MS,
      Math.max(HOUR_MS, visibleSpan.current),
    );
    return createViewportStore(
      { from: horizon.to - span, to: horizon.to },
      horizon,
      HOUR_MS,
      HISTORY_MAX_VIEWPORT_SPAN_MS,
    );
  }, [identity, horizon.from, horizon.to]);
  const acceptedRef = useRef<PilotAcceptedData | null>(null);
  acceptedRef.current = accepted;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const intent = useRef(0),
    mounted = useRef(true),
    timer = useRef<number | null>(null),
    direction = useRef<"back" | "forward">("back"),
    lastPrefetch = useRef(-Infinity),
    tokenSeen = useRef(readToken()),
    prefetchTimer = useRef<number | null>(null),
    leadingAnchor = useRef<number | null>(null),
    previousCenter = useRef<number | null>(null),
    acceptedReceivedAt = useRef<number | null>(null),
    pendingLatest = useRef<{ to: number; span: number } | null>(null);
  const lifetime = useRef(0);
  const cancelTimers = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (prefetchTimer.current !== null)
      window.clearTimeout(prefetchTimer.current);
    timer.current = null;
    prefetchTimer.current = null;
  };
  const clearAccount = () => {
    intent.current += 1;
    loader.clear();
    cancelTimers();
    owner.cancel();
    setZones([]);
    setCards([]);
    setSelectedZoneId(null);
    setSelectedCardId(null);
    setAccepted(null);
    setLoadingRequest(null);
    setFailedRequest(null);
    setError(null);
    setRefreshing(false);
    setStatus("auth-required");
  };
  const observeToken = (): boolean => {
    const current = readTokenRef.current();
    if (current === tokenSeen.current) return Boolean(current);
    tokenSeen.current = current;
    intent.current += 1;
    cancelTimers();
    loader.clear();
    owner.cancel();
    setSessionEpoch((value) => value + 1);
    setZones([]);
    setCards([]);
    setSelectedZoneId(null);
    setSelectedCardId(null);
    setAccepted(null);
    setLoadingRequest(null);
    setFailedRequest(null);
    setError(null);
    setRefreshing(false);
    setStatus(current ? "loading" : "auth-required");
    return false;
  };
  function refreshOnVisible(): void {
    if (!readTokenRef.current() || !acceptedRef.current) return;
    const current = store.get();
    const touchesLatest = current.to >= horizon.to;
    const age =
      acceptedReceivedAt.current === null
        ? Infinity
        : nowRef.current() - acceptedReceivedAt.current;
    if (touchesLatest && age > HISTORY_LATEST_TTL_MS)
      schedule(current, "visibility", { forceFresh: true });
  }
  useEffect(() => {
    const changed = () => {
      if (document.hidden) {
        loader.abortPrefetch();
        if (timer.current !== null) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
      }
      if (document.hidden) {
        loader.abortPrefetch();
        if (prefetchTimer.current !== null) {
          window.clearTimeout(prefetchTimer.current);
          prefetchTimer.current = null;
        }
      }
      if (!observeToken()) return;
      if (!document.hidden) refreshOnVisible();
    };
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [loader, owner, store, horizon, identity]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current += 1;
      owner.cancel();
      loader.clear();
      cancelTimers();
    };
  }, [owner, loader]);
  useEffect(() => {
    if (!readTokenRef.current()) {
      setStatus("auth-required");
      return;
    }
    setStatus("loading");
    void owner
      .run({
        load: (signal, token) => api.getZones({ signal, token }),
        apply: (value) => {
          setZones(value);
          setSelectedZoneId(value[0]?.id ?? null);
          if (!value.length) setStatus("empty");
        },
      })
      .then((r) => {
        if (r === "auth-required") clearAccount();
      })
      .catch((c) => {
        if (c instanceof PilotAuthError) clearAccount();
        else {
          setError(messageFor(c));
          setStatus("error");
        }
      });
  }, [api, owner, sessionEpoch, platform, retryNonce]);
  useEffect(() => {
    if (selectedZoneId === null) return;
    setCards([]);
    setSelectedCardId(null);
    setAccepted(null);
    void owner
      .run({
        load: (signal, token) =>
          api.getCards({ signal, token, zoneId: selectedZoneId }),
        apply: (value) => {
          setCards(value);
          const first = value.find((c) => c.available) ?? value[0];
          setSelectedCardId(first?.cardId ?? null);
          if (!value.length) setStatus("empty");
        },
      })
      .then((r) => {
        if (r === "auth-required") clearAccount();
      })
      .catch((c) => {
        if (c instanceof PilotAuthError) clearAccount();
        else {
          setError(messageFor(c));
          setStatus("error");
        }
      });
  }, [api, owner, selectedZoneId, retryNonce]);
  const prefetch = (visible: Viewport, immediate = false) => {
    if (!observeToken()) return;
    if (
      selectedZoneId === null ||
      selectedCardId === null ||
      !readTokenRef.current() ||
      nowRef.current() - lastPrefetch.current < HISTORY_PREFETCH_COOLDOWN_MS
    )
      return;
    const request = neighborRequest(visible, direction.current, horizon);
    if (!request) return;
    const token = readTokenRef.current()!;
    const lifetimeAtSchedule = lifetime.current;
    const identityAtSchedule = identity;
    if (prefetchTimer.current !== null)
      window.clearTimeout(prefetchTimer.current);
    prefetchTimer.current = window.setTimeout(
      () => {
        prefetchTimer.current = null;
        if (
          document.hidden ||
          !mounted.current ||
          lifetime.current !== lifetimeAtSchedule ||
          identityRef.current !== identityAtSchedule
        )
          return;
        if (readTokenRef.current() !== token) {
          observeToken();
          return;
        }
        lastPrefetch.current = nowRef.current();
        void loader
          .prefetch(
            {
              context: {
                platform,
                sessionEpoch,
                zoneId: selectedZoneId!,
                cardId: selectedCardId!,
              },
              visible: { from: request.from, to: request.to },
              request,
              horizon,
              reason: "prefetch",
              direction: direction.current,
              forceFresh: false,
            },
            (signal) =>
              api.getCardData({
                signal,
                token,
                zoneId: selectedZoneId!,
                cardId: selectedCardId!,
                view: "line-chart",
                request,
              }),
          )
          .catch((c) => {
            if (readTokenRef.current() !== token) {
              observeToken();
              return;
            }
            if (c instanceof PilotAuthError && readTokenRef.current() === token)
              clearAccount();
          });
      },
      immediate ? 0 : HISTORY_PREFETCH_IDLE_MS,
    );
  };
  const schedule = (
    viewport: Viewport,
    reason:
      | "initial"
      | "gesture"
      | "preset"
      | "back"
      | "forward"
      | "latest"
      | "retry"
      | "visibility",
    options: { forceFresh?: boolean; failedRequest?: PilotRangeRequest } = {},
  ) => {
    if (selectedZoneId === null || selectedCardId === null || !observeToken())
      return;
    const card = cards.find((c) => c.cardId === selectedCardId);
    if (!card?.available) return;
    const visible = minuteViewport(viewport),
      request = options.failedRequest ?? bufferedRequest(visible, horizon),
      generation = ++intent.current,
      identityAtStart = identity,
      lifetimeAtStart = lifetime.current,
      token = readTokenRef.current();
    if (!token) {
      clearAccount();
      return;
    }
    const handle = loader.foreground(
      {
        context: {
          platform,
          sessionEpoch,
          zoneId: selectedZoneId,
          cardId: selectedCardId,
        },
        visible,
        request,
        horizon,
        reason,
        direction: direction.current,
        forceFresh:
          options.forceFresh ?? (reason === "latest" || reason === "retry"),
      },
      (signal) => {
        if (readTokenRef.current() !== token)
          throw new PilotAuthError(401, "Session changed");
        return api.getCardData({
          signal,
          token,
          zoneId: selectedZoneId!,
          cardId: selectedCardId!,
          view: "line-chart",
          request,
        });
      },
    );
    const current = () =>
      mounted.current &&
      lifetime.current === lifetimeAtStart &&
      generation === intent.current &&
      identityRef.current === identityAtStart &&
      readTokenRef.current() === token;
    if (handle.source === "cache") {
      setLoadingRequest(null);
      setRefreshing(false);
      setError(null);
    } else {
      setLoadingRequest(request);
      setFailedRequest(null);
      setError(null);
      if (acceptedRef.current) setRefreshing(true);
      else setStatus("loading");
    }
    void handle.result
      .then((value) => {
        if (readTokenRef.current() !== token) {
          observeToken();
          return;
        }
        if (!current()) return;
        const visibleNow = minuteViewport(store.get()),
          direct =
            visibleNow.from === visible.from && visibleNow.to === visible.to,
          reusable =
            !value.data.limits.truncated &&
            value.data.aggregation.level === request.aggregation &&
            coverageContains(value.data, visibleNow, request.aggregation);
        if (!direct && !reusable) return;
        setAccepted(value.data);
        acceptedReceivedAt.current = value.receivedAt;
        setLoadingRequest(null);
        setRefreshing(false);
        setStatus(value.data.series.length ? "ready" : "empty");
        if (!document.hidden) prefetch(visibleNow);
      })
      .catch((c) => {
        if (readTokenRef.current() !== token) {
          observeToken();
          return;
        }
        if (
          c instanceof PilotAuthError &&
          readTokenRef.current() === token &&
          mounted.current &&
          lifetime.current === lifetimeAtStart
        ) {
          clearAccount();
          return;
        }
        if (!current() || c instanceof PilotHistoryAbortError) return;
        setLoadingRequest(null);
        setRefreshing(false);
        if (c instanceof PilotAuthError) clearAccount();
        else {
          setFailedRequest(request);
          setError(
            `${messageFor(c)} · Unable to load ${new Date(request.from).toLocaleString()} – ${new Date(request.to).toLocaleString()}`,
          );
          setStatus(acceptedRef.current ? "ready" : "error");
        }
      });
  };
  useEffect(() => {
    intent.current++;
    setAccepted(null);
    setLoadingRequest(null);
    setFailedRequest(null);
    setError(null);
    if (selectedZoneId !== null && selectedCardId !== null)
      schedule(store.get(), "initial");
  }, [identity, cards]);
  useEffect(() => {
    const pending = pendingLatest.current;
    if (!pending || pending.to !== horizon.to) return;
    pendingLatest.current = null;
    const next = { from: horizon.to - pending.span, to: horizon.to };
    store.set(next, "external");
    schedule(next, "latest", { forceFresh: true });
  }, [horizon.to, store]);
  useEffect(() => {
    if (selectedZoneId === null || selectedCardId === null) return;
    const initialViewport = store.get();
    leadingAnchor.current = (initialViewport.from + initialViewport.to) / 2;
    previousCenter.current = leadingAnchor.current;
    const unsubscribe = store.subscribe((viewport, source) => {
      if (source !== "gesture") return;
      setLoadingRequest(null);
      setRefreshing(false);
      if (prefetchTimer.current !== null) {
        window.clearTimeout(prefetchTimer.current);
        prefetchTimer.current = null;
      }
      intent.current++;
      const span = viewport.to - viewport.from;
      const center = (viewport.from + viewport.to) / 2;
      const movedDirection =
        previousCenter.current !== null
          ? center < previousCenter.current
            ? "back"
            : "forward"
          : direction.current;
      previousCenter.current = center;
      if (
        leadingAnchor.current !== null &&
        Math.abs(center - leadingAnchor.current) >= span * 0.05
      ) {
        if (direction.current !== movedDirection) loader.abortPrefetch();
        direction.current = movedDirection;
        prefetch(viewport, true);
        leadingAnchor.current = center;
      }
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        schedule(viewport, "gesture");
      }, HISTORY_SETTLE_MS);
    });
    return () => {
      unsubscribe();
      cancelTimers();
      loader.abortPrefetch();
    };
  }, [store, selectedZoneId, selectedCardId, horizon, identity]);
  const selectZone = (id: number) => {
    if (zones.some((z) => z.id === id)) {
      if (selectedZoneId === id) return;
      cancelTimers();
      loader.clear();
      setCards([]);
      setSelectedCardId(null);
      setAccepted(null);
      setLoadingRequest(null);
      setFailedRequest(null);
      setError(null);
      setSelectedZoneId(id);
    }
  };
  const selectCard = (id: string) => {
    if (cards.some((c) => c.cardId === id)) {
      if (selectedCardId === id) return;
      cancelTimers();
      loader.clear();
      setAccepted(null);
      setLoadingRequest(null);
      setFailedRequest(null);
      setError(null);
      setSelectedCardId(id);
    }
  };
  const selectPreset = (span: "24h" | "7d" | "30d" | "90d") => {
    const durations = {
        "24h": DAY_MS,
        "7d": 7 * DAY_MS,
        "30d": 30 * DAY_MS,
        "90d": 90 * DAY_MS,
      },
      to = store.get().to,
      next = { from: Math.max(horizon.from, to - durations[span]), to };
    visibleSpan.current = durations[span];
    cancelTimers();
    store.set(next, "external");
    schedule(next, "preset");
  };
  const moveWindow = (way: "back" | "forward") => {
    const cur = store.get(),
      span = cur.to - cur.from,
      from = Math.max(
        horizon.from,
        Math.min(
          cur.from + span * 0.8 * (way === "back" ? -1 : 1),
          horizon.to - span,
        ),
      ),
      next = { from, to: from + span };
    direction.current = way;
    visibleSpan.current = span;
    cancelTimers();
    store.set(next, "external");
    schedule(next, way);
  };
  const showLatest = () => {
    cancelTimers();
    const to = Math.floor(nowRef.current() / MINUTE_MS) * MINUTE_MS,
      span = store.get().to - store.get().from,
      next = { from: to - span, to };
    visibleSpan.current = span;
    if (to === horizon.to) {
      cancelTimers();
      store.set(next, "external");
      schedule(next, "latest", { forceFresh: true });
    } else {
      pendingLatest.current = { to, span };
      setHorizonEnd(to);
    }
  };
  const retry = () => {
    cancelTimers();
    if (selectedZoneId !== null && selectedCardId !== null)
      schedule(store.get(), "retry", {
        forceFresh: true,
        failedRequest: failedRequest ?? loadingRequest ?? undefined,
      });
    else setRetryNonce((value) => value + 1);
  };
  return {
    contextKey: `${platform}:${sessionEpoch}`,
    status,
    zones,
    cards,
    selectedZoneId,
    selectedCardId,
    accepted,
    loadingRequest,
    failedRequest,
    error,
    refreshing,
    horizon,
    store,
    selectZone,
    selectCard,
    selectPreset,
    moveWindow,
    showLatest,
    retry,
  };
}
