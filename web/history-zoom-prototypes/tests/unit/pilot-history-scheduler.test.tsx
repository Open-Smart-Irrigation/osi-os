import { act, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePilotHistory, type UsePilotHistoryResult } from "../../src/pilot/usePilotHistory";
import type {
  PilotAcceptedData,
  PilotApi,
  PilotCard,
  PilotRangeRequest,
  PilotZone,
} from "../../src/pilot/types";
import { neighborRequest } from "../../src/pilot/range";
import { DAY_MS, MINUTE_MS } from "../../src/shared/types";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CardCall = {
  request: PilotRangeRequest;
  signal: AbortSignal;
  result: Deferred<PilotAcceptedData>;
};

const card = (): PilotCard => ({
  cardId: "soil",
  cardType: "soil",
  title: "Soil",
  views: ["line-chart"],
  sourceLabels: [],
  available: true,
});

function accepted(request: PilotRangeRequest, marker = "accepted"): PilotAcceptedData {
  return {
    cardId: "soil",
    request,
    coverage: { from: request.from, to: request.to },
    series: [{
      id: "swt",
      label: marker,
      unit: "kPa",
      points: [{ t: request.from, value: 0 }, { t: request.to, value: 1 }],
    }],
    unitGroups: [{ unit: "kPa", label: "kPa", seriesIds: ["swt"] }],
    aggregation: { level: request.aggregation, pointCount: 2 },
    limits: { maxPointsPerSeries: 2_000, truncated: false },
  };
}

function makeApi(calls: CardCall[]): PilotApi {
  return {
    getZones: async (): Promise<PilotZone[]> => [{ id: 7, name: "North" }],
    getCards: async (): Promise<PilotCard[]> => [card()],
    getCardData: ({ request, signal }) => {
      const result = deferred<PilotAcceptedData>();
      calls.push({ request, signal, result });
      return result.promise;
    },
  };
}

function Capture({
  api,
  now,
  onValue,
}: {
  api: PilotApi;
  now: () => number;
  onValue(value: UsePilotHistoryResult): void;
}) {
  const value = usePilotHistory({
    platform: "edge",
    api,
    readToken: () => "session",
    now,
  });
  onValue(value);
  return null;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await flushMicrotasks();
  });
}

async function renderHistory(now: () => number, calls: CardCall[]) {
  let value!: UsePilotHistoryResult;
  const view = render(
    <Capture api={makeApi(calls)} now={now} onValue={(next) => { value = next; }} />,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return { view, getValue: () => value };
}

async function accept(call: CardCall, marker?: string) {
  await act(async () => {
    call.result.resolve(accepted(call.request, marker));
    await flushMicrotasks();
  });
}

describe("usePilotHistory scheduler", () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");

  afterEach(() => {
    if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
    else delete (document as { hidden?: boolean }).hidden;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("cancels a settled gesture when Latest is chosen before 150ms", async () => {
    vi.useFakeTimers();
    let clock = 100 * DAY_MS + 31 * MINUTE_MS;
    const calls: CardCall[] = [];
    const { view, getValue } = await renderHistory(() => clock, calls);
    expect(calls).toHaveLength(1);
    await accept(calls[0]);

    const current = getValue().store.get();
    act(() => {
      getValue().store.set(
        { from: current.from - 3 * MINUTE_MS, to: current.to - 3 * MINUTE_MS },
        "gesture",
      );
      clock += MINUTE_MS;
      getValue().showLatest();
    });
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    await advance(150);
    expect(calls).toHaveLength(2);
    view.unmount();
  });

  it("makes one changed-minute Latest request and a duplicate Latest joins it", async () => {
    vi.useFakeTimers();
    let clock = 100 * DAY_MS + 31 * MINUTE_MS;
    const calls: CardCall[] = [];
    const { view, getValue } = await renderHistory(() => clock, calls);
    await accept(calls[0]);
    clock += 2 * MINUTE_MS;
    act(() => getValue().showLatest());
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(calls[1].request.to).toBe(Math.floor(clock / MINUTE_MS) * MINUTE_MS);
    act(() => getValue().showLatest());
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    await accept(calls[1], "latest");
    expect(getValue().accepted?.series[0]?.label).toBe("latest");
    view.unmount();
  });

  it("starts one directional prefetch after cumulative small gesture steps", async () => {
    vi.useFakeTimers();
    let clock = 100 * DAY_MS + 31 * MINUTE_MS;
    const calls: CardCall[] = [];
    const { view, getValue } = await renderHistory(() => clock, calls);
    await accept(calls[0]);
    const initial = getValue().store.get();
    const span = initial.to - initial.from;
    const step = span * 0.03;
    act(() => getValue().store.set({ from: initial.from - step, to: initial.to - step }, "gesture"));
    act(() => getValue().store.set({ from: initial.from - 2 * step, to: initial.to - 2 * step }, "gesture"));
    await advance(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].request).toEqual(
      neighborRequest(getValue().store.get(), "back", getValue().horizon),
    );
    await advance(500);
    expect(calls.length).toBeLessThanOrEqual(3);
    view.unmount();
  });

  it("aborts stale Back prefetch when motion reverses toward Forward", async () => {
    vi.useFakeTimers();
    let clock = 100 * DAY_MS + 31 * MINUTE_MS;
    const calls: CardCall[] = [];
    const { view, getValue } = await renderHistory(() => clock, calls);
    await accept(calls[0]);
    const initial = getValue().store.get();
    const span = initial.to - initial.from;
    const step = span * 0.1;
    act(() => getValue().store.set(
      { from: initial.from - 10 * DAY_MS, to: initial.to - 10 * DAY_MS },
      "external",
    ));
    const historical = getValue().store.get();
    act(() => getValue().store.set({ from: historical.from - step, to: historical.to - step }, "gesture"));
    const backViewport = getValue().store.get();
    await advance(0);
    expect(calls).toHaveLength(2);
    const back = calls[1];
    expect(back.request).toEqual(neighborRequest(backViewport, "back", getValue().horizon));
    expect(back.signal.aborted).toBe(false);

    // The loader's prefetch cooldown is 500 ms. Keep the gesture settle timer
    // moving while the cooldown expires, then cross the leading threshold.
    for (let i = 0; i < 5; i += 1) {
      clock += 100;
      await advance(100);
      const current = getValue().store.get();
      act(() => getValue().store.set({ from: current.from + 1, to: current.to + 1 }, "gesture"));
    }
    const forwardViewport = getValue().store.get();
    act(() => getValue().store.set(
      { from: forwardViewport.from + 0.06 * span, to: forwardViewport.to + 0.06 * span },
      "gesture",
    ));
    await advance(0);
    expect(back.signal.aborted).toBe(true);
    const expectedForward = neighborRequest(getValue().store.get(), "forward", getValue().horizon);
    const forwardCalls = calls.filter((call) =>
      JSON.stringify(call.request) === JSON.stringify(expectedForward),
    );
    expect(forwardCalls).toHaveLength(1);
    view.unmount();
  });

  it("does not prefetch while hidden while foreground data is pending", async () => {
    vi.useFakeTimers();
    const clock = 100 * DAY_MS + 31 * MINUTE_MS;
    const calls: CardCall[] = [];
    const { view } = await renderHistory(() => clock, calls);
    expect(calls).toHaveLength(1);
    const hidden = vi.spyOn(document, "hidden", "get");
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(600);
    expect(calls).toHaveLength(1);
    await accept(calls[0]);
    await advance(600);
    expect(calls).toHaveLength(1);
    view.unmount();
  });

  it("does not schedule from an external store write, and refreshes a stale latest view", async () => {
    vi.useFakeTimers();
    let clock = 100 * DAY_MS + 31 * MINUTE_MS;
    const calls: CardCall[] = [];
    const { view, getValue } = await renderHistory(() => clock, calls);
    await accept(calls[0]);
    await advance(500);
    const initialCount = calls.length;
    const current = getValue().store.get();
    act(() => getValue().store.set({ from: current.from - DAY_MS, to: current.to - DAY_MS }, "external"));
    await advance(600);
    expect(calls).toHaveLength(initialCount);
    act(() => getValue().store.set({ from: current.from, to: current.to }, "external"));
    clock += 16_000;
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(calls).toHaveLength(initialCount + 1);
    view.unmount();
  });
});
