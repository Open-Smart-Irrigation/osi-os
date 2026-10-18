import { describe, expect, test } from "vitest";
import {
  bufferedRequest,
  coverageContains,
  HISTORY_MAX_VIEWPORT_SPAN_MS,
  HISTORY_NAVIGATION_START_MS,
  minuteViewport,
  neighborRequest,
  requestForViewport,
} from "../../src/pilot/range";
import { DAY_MS, HOUR_MS, type Viewport } from "../../src/shared/types";

describe("pilot range policy", () => {
  test("separates epoch navigation from the ninety-day viewport cap", () => {
    expect(HISTORY_NAVIGATION_START_MS).toBe(0);
    expect(HISTORY_MAX_VIEWPORT_SPAN_MS).toBe(90 * DAY_MS);
    expect(requestForViewport({ from: 0, to: DAY_MS }).aggregation).toBe("raw");
    expect(requestForViewport({ from: 0, to: 90 * DAY_MS }).aggregation).toBe(
      "daily",
    );
  });
  test.each([
    [24 * HOUR_MS, "raw"],
    [7 * DAY_MS, "15m"],
    [30 * DAY_MS, "hourly"],
    [90 * DAY_MS, "daily"],
  ] as const)("chooses the aggregation for %s", (span, aggregation) => {
    expect(requestForViewport({ from: 0, to: span }).aggregation).toBe(
      aggregation,
    );
  });

  test("uses daily with the 30d server label for long requests", () => {
    expect(requestForViewport({ from: 0, to: 90 * DAY_MS })).toMatchObject({
      rangeLabel: "30d",
      aggregation: "daily",
    });
  });

  test("floors both endpoints without widening an exact day", () => {
    const viewport = { from: 61_234, to: 86_461_234 };
    expect(minuteViewport(viewport)).toEqual({ from: 60_000, to: 86_460_000 });
    expect(minuteViewport({ from: 0, to: DAY_MS })).toEqual({
      from: 0,
      to: DAY_MS,
    });
  });

  test("pads inside the horizon and clamps tier boundaries", () => {
    expect(
      bufferedRequest(
        { from: 10 * DAY_MS, to: 10.5 * DAY_MS },
        { from: 0, to: 90 * DAY_MS },
      ),
    ).toMatchObject({
      from: 9.875 * DAY_MS,
      to: 10.625 * DAY_MS,
    });
    expect(
      bufferedRequest({ from: 0, to: DAY_MS }, { from: 0, to: 90 * DAY_MS })
        .from,
    ).toBe(0);
    expect(
      bufferedRequest(
        { from: 89 * DAY_MS, to: 90 * DAY_MS },
        { from: 0, to: 90 * DAY_MS },
      ).to,
    ).toBe(90 * DAY_MS);
    expect(
      bufferedRequest(
        { from: 6 * DAY_MS, to: 7 * DAY_MS },
        { from: 0, to: 90 * DAY_MS },
      ).to,
    ).toBe(7 * DAY_MS);
  });

  test("requires both coverage and requested aggregation to match", () => {
    const accepted = {
      coverage: { from: 0, to: 10 },
      request: {
        from: 0,
        to: 10,
        rangeLabel: "24h" as const,
        aggregation: "raw" as const,
      },
    };
    expect(coverageContains(accepted, { from: 1, to: 9 }, "raw")).toBe(true);
    expect(coverageContains(accepted, { from: -1, to: 9 }, "raw")).toBe(false);
    expect(coverageContains(accepted, { from: 1, to: 9 }, "15m")).toBe(false);
  });

  test("shifts a latest day window back by exactly eighty percent", () => {
    const horizon = { from: 0, to: 90 * DAY_MS };
    expect(
      neighborRequest({ from: 89 * DAY_MS, to: 90 * DAY_MS }, "back", horizon),
    ).toMatchObject({
      from: 88.2 * DAY_MS,
      to: 89.2 * DAY_MS,
      aggregation: "raw",
    });
  });

  test("returns null when a directional move cannot make progress", () => {
    const horizon = { from: 0, to: 90 * DAY_MS };
    expect(neighborRequest({ from: 0, to: 0 }, "forward", horizon)).toBeNull();
  });

  test("preserves the full span when clamping at either horizon edge", () => {
    const horizon = { from: 0, to: 10 * DAY_MS };
    const span = DAY_MS;
    expect(neighborRequest({ from: 0, to: span }, "back", horizon)).toBeNull();
    expect(
      neighborRequest(
        { from: 9 * DAY_MS, to: 10 * DAY_MS },
        "forward",
        horizon,
      ),
    ).toBeNull();
    expect(
      neighborRequest(
        { from: 0.5 * DAY_MS, to: 1.5 * DAY_MS },
        "back",
        horizon,
      ),
    ).toMatchObject({ from: 0, to: span });
    expect(
      neighborRequest(
        { from: 8.5 * DAY_MS, to: 9.5 * DAY_MS },
        "forward",
        horizon,
      ),
    ).toMatchObject({ from: 9 * DAY_MS, to: 10 * DAY_MS });
  });

  test("rejects non-finite or invalid directional viewports", () => {
    const horizon = { from: 0, to: 10 * DAY_MS };
    expect(
      neighborRequest({ from: Number.NaN, to: 1 }, "back", horizon),
    ).toBeNull();
    expect(
      neighborRequest(
        { from: 1, to: Number.POSITIVE_INFINITY },
        "forward",
        horizon,
      ),
    ).toBeNull();
    expect(neighborRequest({ from: 8, to: 2 }, "forward", horizon)).toBeNull();
  });

  test.each([
    [7 * DAY_MS, "15m"],
    [30 * DAY_MS, "hourly"],
    [90 * DAY_MS, "daily"],
  ] as const)(
    "preserves the %s tier and full span for directional neighbors",
    (windowSpan, aggregation) => {
      const horizon = { from: 0, to: 180 * DAY_MS };
      const viewport = { from: 60 * DAY_MS, to: 60 * DAY_MS + windowSpan };
      const back = neighborRequest(viewport, "back", horizon);
      const forward = neighborRequest(viewport, "forward", horizon);
      expect(back?.aggregation).toBe(aggregation);
      expect(forward?.aggregation).toBe(aggregation);
      if (!back || !forward)
        throw new Error("expected both directional neighbors");
      expect(back.to - back.from).toBe(windowSpan);
      expect(forward.to - forward.from).toBe(windowSpan);
      expect(back?.from).toBeLessThanOrEqual(viewport.from);
      expect(back?.to).toBeGreaterThanOrEqual(viewport.to - windowSpan * 0.8);
      expect(forward?.from).toBeLessThanOrEqual(
        viewport.from + windowSpan * 0.8,
      );
      expect(forward?.to).toBeGreaterThanOrEqual(viewport.to);
    },
  );

  test("a full 90-day horizon has no directional progress", () => {
    const horizon = { from: 0, to: 90 * DAY_MS };
    const viewport = { from: 0, to: 90 * DAY_MS };
    expect(neighborRequest(viewport, "back", horizon)).toBeNull();
    expect(neighborRequest(viewport, "forward", horizon)).toBeNull();
  });
});
