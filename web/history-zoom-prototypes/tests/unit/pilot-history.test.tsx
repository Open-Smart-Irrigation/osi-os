import { act, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  PilotApi,
  PilotAcceptedData,
  PilotCard,
  PilotHistoryLoader,
  PilotRangeRequest,
  PilotZone,
} from "../../src/pilot/types";
import { createPilotHistoryLoader } from "../../src/pilot/historyLoader";
import { usePilotHistory } from "../../src/pilot/usePilotHistory";
import { PilotAuthError } from "../../src/pilot/types";
import { DAY_MS } from "../../src/shared/types";

const accepted = (
  cardId: string,
  request: PilotRangeRequest = {
    from: 1_000,
    to: 86_401_000,
    rangeLabel: "24h" as const,
    aggregation: "raw" as const,
  },
  marker = "SWT",
): PilotAcceptedData => ({
  cardId,
  request,
  coverage: { from: request.from, to: request.to },
  series: [
    {
      id: "swt",
      label: marker,
      unit: "kPa",
      points: [
        { t: request.from, value: 0 },
        { t: request.to, value: null },
      ],
    },
  ],
  unitGroups: [{ unit: "kPa", label: "kPa", seriesIds: ["swt"] }],
  aggregation: { level: "raw", pointCount: 2 },
  limits: { maxPointsPerSeries: 2_000, truncated: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Probe({
  api,
  readToken,
  now = () => 86_401_000,
  historyLoader,
}: {
  api: PilotApi;
  readToken: () => string | null;
  now?: () => number;
  historyLoader?: PilotHistoryLoader;
}) {
  const [, redraw] = React.useState(0);
  const value = usePilotHistory({
    platform: "edge",
    api,
    readToken,
    now,
    historyLoader,
  });
  return (
    <>
      <output data-testid="status">{value.status}</output>
      <output data-testid="refreshing">{String(value.refreshing)}</output>
      <output data-testid="accepted">{value.accepted?.cardId ?? ""}</output>
      <output data-testid="marker">
        {value.accepted?.series[0]?.label ?? ""}
      </output>
      <output data-testid="failed">
        {value.failedRequest
          ? `${value.failedRequest.from}:${value.failedRequest.to}`
          : ""}
      </output>
      <output data-testid="span">
        {value.store.get().to - value.store.get().from}
      </output>
      <output data-testid="bounds">
        {value.store.get().from}:{value.store.get().to}
      </output>
      <button onClick={() => value.selectCard("soil")}>card</button>
      <button onClick={() => value.retry()}>retry</button>
      <button
        onClick={() => {
          value.store.set(
            { from: 2 * 86_400_000, to: 2 * 86_400_000 + 10 * 60 * 60 * 1000 },
            "gesture",
          );
          redraw((n) => n + 1);
        }}
      >
        pan
      </button>
      <button
        onClick={() => {
          value.store.set(
            { from: 120_000, to: 120_000 + 7 * 86_400_000 },
            "gesture",
          );
          redraw((n) => n + 1);
        }}
      >
        latest-pan
      </button>
      <button
        onClick={() => {
          value.showLatest();
          redraw((n) => n + 1);
        }}
      >
        latest
      </button>
      <button onClick={() => value.moveWindow("back")}>back</button>
      <button onClick={() => value.moveWindow("forward")}>forward</button>
      <button onClick={() => value.selectPreset("90d")}>90d</button>
    </>
  );
}

describe("usePilotHistory lifecycle", () => {
  it("navigates older than the former ninety-day floor while keeping requests bounded", async () => {
    const now = 365 * DAY_MS + 123_000;
    const requests: PilotRangeRequest[] = [];
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [{ cardId: "soil", cardType: "soil", title: "Soil", views: ["line-chart"], sourceLabels: [], available: true }],
      getCardData: async ({ request }) => { requests.push(request); return accepted("soil", request); },
    };
    render(<Probe api={api} readToken={() => "session"} now={() => now} />);
    await waitFor(() => expect(screen.getByTestId("accepted").textContent).toBe("soil"));
    await act(async () => { screen.getByText("90d").click(); screen.getByText("back").click(); await Promise.resolve(); });
    await waitFor(() => expect(requests.length).toBeGreaterThan(1));
    const current = screen.getByTestId("bounds").textContent!.split(":").map(Number);
    expect(current[0]).toBeLessThan(now - 90 * DAY_MS);
    expect(requests.every((request) => request.to - request.from <= 90 * DAY_MS)).toBe(true);
    await act(async () => { screen.getByText("latest").click(); await Promise.resolve(); });
    expect(screen.getByTestId("bounds").textContent).toBe(`${Math.floor(now / 60_000) * 60_000 - 90 * DAY_MS}:${Math.floor(now / 60_000) * 60_000}`);
  });

  it("does not dispatch an idle prefetch under a replacement token", async () => {
    let token: string | null = "old";
    let requests = 0;
    let zones = 0;
    const newCatalog = deferred<PilotZone[]>();
    const api: PilotApi = {
      getZones: async () =>
        ++zones === 1 ? [{ id: 7, name: "North" }] : newCatalog.promise,
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async ({ request }) => {
        requests += 1;
        return accepted("soil", request, token === "old" ? "OLD" : "NEW");
      },
    };
    render(<Probe api={api} readToken={() => token} now={() => 90 * DAY_MS} />);
    await waitFor(() =>
      expect(screen.getByTestId("marker").textContent).toBe("OLD"),
    );
    token = "new";
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(screen.getByTestId("marker").textContent).toBe("");
    expect(requests).toBe(1);
    newCatalog.resolve([{ id: 7, name: "North" }]);
  });
  it("clears the old account when a deferred foreground settles after a silent token change", async () => {
    let token: string | null = "old";
    let catalogCall = 0;
    let dataCalls = 0;
    const foreground = deferred<PilotAcceptedData>();
    const newCatalog = deferred<PilotZone[]>();
    const api: PilotApi = {
      getZones: async () =>
        ++catalogCall === 1 ? [{ id: 7, name: "North" }] : newCatalog.promise,
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async ({ request }) =>
        ++dataCalls === 1
          ? accepted("soil", request, "OLD")
          : foreground.promise,
    };
    render(<Probe api={api} readToken={() => token} now={() => 90 * DAY_MS} />);
    await waitFor(() =>
      expect(screen.getByTestId("marker").textContent).toBe("OLD"),
    );
    act(() => screen.getByText("back").click());
    await waitFor(() => expect(dataCalls).toBe(2));
    token = "new";
    foreground.reject(new Error("expired"));
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe(""),
    );
    expect(screen.getByTestId("status").textContent).toBe("loading");
    expect(screen.getByTestId("marker").textContent).toBe("");
    newCatalog.resolve([{ id: 7, name: "North" }]);
  });

  it("clears the session when a demoted foreground reports 401 even if a newer foreground is current", async () => {
    const first = deferred<PilotAcceptedData>();
    const second = deferred<PilotAcceptedData>();
    let cardRequests = 0;
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async ({ request }) => {
        cardRequests += 1;
        return cardRequests === 1
          ? accepted("soil", request, "OLD")
          : cardRequests === 2
            ? first.promise
            : second.promise;
      },
    };
    render(<Probe api={api} readToken={() => "session"} now={() => 90 * DAY_MS} />);
    await waitFor(() =>
      expect(screen.getByTestId("marker").textContent).toBe("OLD"),
    );
    act(() => screen.getByText("back").click());
    await waitFor(() => expect(cardRequests).toBe(2));
    act(() => screen.getByText("back").click());
    await waitFor(() => expect(cardRequests).toBe(3));
    first.reject(new PilotAuthError(401, "expired"));
    second.resolve(
      accepted(
        "soil",
        {
          from: 3 * DAY_MS,
          to: 4 * DAY_MS,
          rangeLabel: "24h",
          aggregation: "raw",
        },
        "LATE",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("auth-required"),
    );
    expect(screen.getByTestId("accepted").textContent).toBe("");
  });

  it("treats selecting the current card as a no-op and preserves accepted data", async () => {
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async ({ request }) => accepted("soil", request, "KEEP"),
    };
    render(<Probe api={api} readToken={() => "session"} />);
    await waitFor(() =>
      expect(screen.getByTestId("marker").textContent).toBe("KEEP"),
    );
    await act(async () => {
      screen.getByText("card").click();
      await Promise.resolve();
    });
    expect(screen.getByTestId("marker").textContent).toBe("KEEP");
  });

  it("clears exact old-account cache data before a same-tab session can render new catalog data", async () => {
    let token: string | null = "old";
    let zoneCalls = 0;
    let cardCalls = 0;
    let resolveNewZones!: (value: PilotZone[]) => void;
    let resolveNewCards!: (value: PilotCard[]) => void;
    const newZones = new Promise<PilotZone[]>((resolve) => {
      resolveNewZones = resolve;
    });
    const newCards = new Promise<PilotCard[]>((resolve) => {
      resolveNewCards = resolve;
    });
    const api: PilotApi = {
      getZones: async () => {
        zoneCalls += 1;
        return zoneCalls === 1 ? [{ id: 7, name: "North" }] : newZones;
      },
      getCards: async () => {
        cardCalls += 1;
        return cardCalls === 1
          ? [
              {
                cardId: "soil",
                cardType: "soil",
                title: "Soil",
                views: ["line-chart"],
                sourceLabels: [],
                available: true,
              },
            ]
          : newCards;
      },
      getCardData: async ({ request }) =>
        accepted("soil", request, token === "old" ? "OLD" : "NEW"),
    };
    render(<Probe api={api} readToken={() => token} />);
    await waitFor(() =>
      expect(screen.getByTestId("marker").textContent).toBe("OLD"),
    );
    await act(async () => {
      screen.getByText("back").click();
      await Promise.resolve();
    });
    token = "new";
    await act(async () => {
      screen.getByText("forward").click();
      await Promise.resolve();
    });
    expect(screen.getByTestId("accepted").textContent).toBe("");
    expect(screen.getByTestId("marker").textContent).toBe("");
    resolveNewZones([{ id: 7, name: "North" }]);
    resolveNewCards([
      {
        cardId: "soil",
        cardType: "soil",
        title: "Soil",
        views: ["line-chart"],
        sourceLabels: [],
        available: true,
      },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("marker").textContent).toBe("NEW"),
    );
  });

  it("does not reuse cached history after a same-tab token replacement", async () => {
    let token: string | null = "old";
    const seen: string[] = [];
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async ({ token: requestToken }) => {
        seen.push(requestToken);
        return accepted("soil");
      },
    };
    render(<Probe api={api} readToken={() => token} />);
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe("soil"),
    );
    token = "new";
    await act(async () => {
      screen.getByText("pan").click();
      await Promise.resolve();
    });
    await waitFor(() => expect(seen.at(-1)).toBe("new"));
    expect(seen).toContain("old");
  });

  it("survives StrictMode effect replay and still loads once for the active card", async () => {
    let requests = 0;
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async () => {
        requests += 1;
        return accepted("soil");
      },
    };
    render(
      <React.StrictMode>
        <Probe api={api} readToken={() => "session"} />
      </React.StrictMode>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe("soil"),
    );
    expect(requests).toBe(1);
  });

  it("refreshes a stale latest window on visible return", async () => {
    const clock = { value: 86_401_000 };
    let requests = 0;
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async () => {
        requests += 1;
        return accepted("soil");
      },
    };
    const historyLoader = createPilotHistoryLoader({ now: () => clock.value });
    render(
      <Probe
        api={api}
        readToken={() => "session"}
        now={() => clock.value}
        historyLoader={historyLoader}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe("soil"),
    );
    const initialRequests = requests;
    clock.value += 16_000;
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    hidden = false;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(requests).toBeGreaterThan(initialRequests));
  });

  it("loads account and clears all accepted data when the session is revoked", async () => {
    let token: string | null = "session";
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async () => accepted("soil"),
    };
    render(<Probe api={api} readToken={() => token} />);
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe("soil"),
    );
    expect(screen.getByTestId("accepted").textContent).toBe("soil");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "auth_token",
        oldValue: "session",
        newValue: "other",
      }),
    );
    token = null;
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "auth_token",
          oldValue: "session",
          newValue: null,
        }),
      ),
    );
    expect(screen.getByTestId("accepted").textContent).toBe("");
    expect(screen.getByTestId("status").textContent).toBe("auth-required");
  });

  it("does not write the viewport when a response is accepted", async () => {
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async () => accepted("soil"),
    };
    let store: ReturnType<typeof usePilotHistory>["store"] | undefined;
    function Capture() {
      const value = usePilotHistory({
        platform: "edge",
        api,
        readToken: () => "session",
        now: () => 86_401_000,
      });
      store = value.store;
      return null;
    }
    render(<Capture />);
    const before = store?.get();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(store?.get()).toEqual(before);
  });

  it("retries the exact failed buffered request after a settled viewport miss and keeps accepted data", async () => {
    const requests: Array<{ from: number; to: number }> = [];
    let attempts = 0;
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async ({ request }) => {
        requests.push(request);
        attempts += 1;
        if (attempts === 2 || attempts === 3) throw new Error("offline");
        return accepted("soil");
      },
    };
    render(
      <Probe
        api={api}
        readToken={() => "session"}
        now={() => 90 * 86_400_000}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe("soil"),
    );
    await act(async () => {
      screen.getByText("pan").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("failed").textContent).not.toBe(""),
    );
    expect(screen.getByTestId("accepted").textContent).toBe("soil");
    const failed = screen.getByTestId("failed").textContent;
    await act(async () => {
      screen.getByText("retry").click();
    });
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe("soil"),
    );
    await waitFor(() => expect(requests.length).toBe(4));
    expect(requests[3]).toEqual(requests[2]);
  });

  it("Latest returns a panned viewport to the current minute while preserving its span", async () => {
    const api: PilotApi = {
      getZones: async () => [{ id: 7, name: "North" }],
      getCards: async () => [
        {
          cardId: "soil",
          cardType: "soil",
          title: "Soil",
          views: ["line-chart"],
          sourceLabels: [],
          available: true,
        },
      ],
      getCardData: async () => accepted("soil"),
    };
    const clock = { value: 90 * 86_400_000 + 123_000 };
    render(
      <Probe api={api} readToken={() => "session"} now={() => clock.value} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("accepted").textContent).toBe("soil"),
    );
    await act(async () => {
      screen.getByText("latest-pan").click();
    });
    const oldFrom = 120_000;
    expect(screen.getByTestId("bounds").textContent).toBe(
      `${oldFrom}:${oldFrom + 7 * 86_400_000}`,
    );
    await act(async () => {
      screen.getByText("latest").click();
    });
    const latestEnd = Math.floor(clock.value / 60_000) * 60_000;
    expect(screen.getByTestId("bounds").textContent).toBe(
      `${latestEnd - 7 * 86_400_000}:${latestEnd}`,
    );
    clock.value += 86_400_000;
    await act(async () => {
      screen.getByText("latest").click();
    });
    const advancedEnd = Math.floor(clock.value / 60_000) * 60_000;
    expect(screen.getByTestId("bounds").textContent).toBe(
      `${advancedEnd - 7 * 86_400_000}:${advancedEnd}`,
    );
  });
});
