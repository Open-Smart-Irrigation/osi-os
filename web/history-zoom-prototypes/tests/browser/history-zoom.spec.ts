import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURE_EXTENT, SUITABILITY_CRITERIA, type Candidate } from '../../src/shared/types';
import {
  cancelOneFinger, candidates, criterion, currentPlot, diagnosticsDir, installTouchAudit,
  openCandidate, probe, rendererError, resetViewport, routeResultsDir, settle, span,
  timeAt, touchAudit, viewportDistance, type Criterion, type CriterionResult, type RouteResult,
} from './browser-helpers';
import { dispatchTouchSequence, panPoints, partialLiftPhases, pinchPoints } from './cdp-touch';

const EXPECTED = new Set<string>(SUITABILITY_CRITERIA);

function finish(route: Candidate, partial: Partial<Record<Criterion, CriterionResult>>): RouteResult {
  const keys = Object.keys(partial);
  expect(new Set(keys)).toEqual(EXPECTED);
  for (const key of SUITABILITY_CRITERIA) {
    expect(partial[key], `${route} did not measure ${key}`).toBeDefined();
    expect(partial[key]?.status, `${route} ${key}: ${JSON.stringify(partial[key]?.observed)}`).toBe('PASS');
  }
  return { route, criteria: partial as Record<Criterion, CriterionResult> };
}

async function panRightFromRightEdge(page: Page): Promise<{ before: Awaited<ReturnType<typeof probe>>; after: Awaited<ReturnType<typeof probe>> }> {
  const before = await resetViewport(page);
  const cdp = await page.context().newCDPSession(page);
  await dispatchTouchSequence(cdp, panPoints(before.plotRect, {
    fromX: before.plotRect.width * 0.38,
    toX: before.plotRect.width * 0.68,
    steps: 10,
  }));
  await settle(page);
  const after = await probe(page);
  await cdp.detach();
  return { before, after };
}

async function measureRoute(page: Page, route: Candidate): Promise<RouteResult> {
  await openCandidate(page, route);
  const measurements: Partial<Record<Criterion, CriterionResult>> = {};
  const cdp = await page.context().newCDPSession(page);

  // A finger moving right at the initial right-edge viewport must move the
  // visible time window earlier, away from the right extent clamp.
  let start = await resetViewport(page);
  await dispatchTouchSequence(cdp, panPoints(start.plotRect, {
    fromX: start.plotRect.width * 0.38, toX: start.plotRect.width * 0.68, steps: 10,
  }));
  await settle(page);
  let end = await probe(page);
  const rightPanShift = start.requestedViewport.to - end.requestedViewport.to;
  measurements['initial-pan'] = criterion(
    rightPanShift >= span(start.requestedViewport) * 0.05 && end.requestedViewport.to < start.requestedViewport.to && rendererError(end) <= 1,
    { fingerDirection: 'right', rightEdgeShiftMs: rightPanShift, renderedErrorMs: rendererError(end) },
  );

  // Spreading 80 -> 160 narrows. Both the 60-move and four-move versions
  // must zoom and must end at equivalent renderer domains.
  const spreadEnds = [];
  for (const steps of [60, 4] as const) {
    start = await resetViewport(page);
    start = await currentPlot(page);
    await dispatchTouchSequence(cdp, pinchPoints(start.plotRect, {
      startGap: 80, endGap: 160, startCenterFraction: 0.5, endCenterFraction: 0.5, steps,
    }));
    await settle(page);
    spreadEnds.push(await probe(page));
  }
  const [sixty, four] = spreadEnds;
  const stepError = Math.abs(span(sixty.renderedViewport) - span(four.renderedViewport)) / span(sixty.renderedViewport);
  measurements['pinch-step-invariance'] = criterion(
    stepError <= 0.01
      && span(sixty.renderedViewport) <= span((await resetViewport(page)).renderedViewport) * 0.9
      && span(four.renderedViewport) <= span((await resetViewport(page)).renderedViewport) * 0.9
      && rendererError(sixty) <= 1 && rendererError(four) <= 1,
    { relativeSpanError: stepError, sixtySpanMs: span(sixty.renderedViewport), fourSpanMs: span(four.renderedViewport) },
  );

  // Closing 160 -> 80 widens.
  start = await resetViewport(page);
  await dispatchTouchSequence(cdp, pinchPoints(start.plotRect, {
    startGap: 160, endGap: 80, startCenterFraction: 0.5, endCenterFraction: 0.5, steps: 12,
  }));
  await settle(page);
  end = await probe(page);
  measurements['reverse-pinch'] = criterion(
    span(end.renderedViewport) >= span(start.renderedViewport) * 1.1 && rendererError(end) <= 1,
    { startSpanMs: span(start.renderedViewport), endSpanMs: span(end.renderedViewport), renderedErrorMs: rendererError(end) },
  );

  // Move away from the right clamp, then prove the time under x=.4 before
  // the gesture remains under x=.6 after it.
  await cdp.detach();
  const positioned = await panRightFromRightEdge(page);
  expect(positioned.after.requestedViewport.from).toBeGreaterThan(FIXTURE_EXTENT.from);
  expect(positioned.after.requestedViewport.to).toBeLessThan(FIXTURE_EXTENT.to);
  const movingStart = await currentPlot(page);
  const movingTime = timeAt(movingStart.renderedViewport, 0.4);
  const movingCdp = await page.context().newCDPSession(page);
  await dispatchTouchSequence(movingCdp, pinchPoints(movingStart.plotRect, {
    startGap: 80, endGap: 144, startCenterFraction: 0.4, endCenterFraction: 0.6, steps: 20,
  }));
  await settle(page);
  const movingEnd = await probe(page);
  const movingDriftPx = Math.abs(movingTime - timeAt(movingEnd.renderedViewport, 0.6)) / span(movingEnd.renderedViewport) * movingEnd.plotRect.width;
  measurements['moving-anchor'] = criterion(
    movingDriftPx <= 2 && rendererError(movingEnd) <= 1,
    { beforeTimeMs: movingTime, afterTimeMs: timeAt(movingEnd.renderedViewport, 0.6), anchorDriftPx: movingDriftPx, renderedErrorMs: rendererError(movingEnd) },
  );

  // Equal Euclidean gap ratios must produce equal spans regardless of axis.
  const axisSpans: number[] = [];
  for (const axis of ['horizontal', 'vertical'] as const) {
    start = await resetViewport(page);
    await dispatchTouchSequence(movingCdp, pinchPoints(start.plotRect, {
      startGap: 80, endGap: 160, startCenterFraction: 0.5, endCenterFraction: 0.5, axis, steps: 12,
    }));
    await settle(page);
    const axisEnd = await probe(page);
    axisSpans.push(span(axisEnd.renderedViewport));
  }
  const axisError = Math.abs(axisSpans[0] - axisSpans[1]) / axisSpans[0];
  measurements['pinch-axis-orientation'] = criterion(axisError <= 0.01, {
    horizontalSpanMs: axisSpans[0], verticalSpanMs: axisSpans[1], relativeSpanError: axisError,
  });

  // Both release orders: real pan -> spread -> release -> remaining pan.
  for (const releaseId of [1, 2] as const) {
    await resetViewport(page);
    await installTouchAudit(page);
    const phaseStart = await currentPlot(page);
    const phases = partialLiftPhases(phaseStart.plotRect, releaseId);
    await dispatchTouchSequence(movingCdp, phases.initialPan);
    await dispatchTouchSequence(movingCdp, phases.spread);
    await settle(page);
    const beforeRelease = await probe(page);
    await dispatchTouchSequence(movingCdp, phases.release);
    await settle(page);
    const afterRelease = await probe(page);
    await dispatchTouchSequence(movingCdp, phases.remainingPan);
    await settle(page);
    const afterPan = await probe(page);
    const jumpPx = viewportDistance(beforeRelease.renderedViewport, afterRelease.renderedViewport) / span(beforeRelease.renderedViewport) * beforeRelease.plotRect.width;
    const remainingShift = Math.abs(afterPan.renderedViewport.from - afterRelease.renderedViewport.from);
    const audit = await touchAudit(page);
    const releaseEvent = audit.find((event) => event.type === 'touchend' && event.changed.length === 1 && event.changed[0] === releaseId);
    const idsCorrect = !!releaseEvent
      && releaseEvent.touches.length === 1
      && releaseEvent.touches[0] === phases.remainingId;
    measurements[`partial-lift-id-${releaseId}`] = criterion(
      jumpPx <= 2 && remainingShift >= span(afterRelease.renderedViewport) * 0.05 && idsCorrect && rendererError(afterPan) <= 1,
      { releaseId, remainingId: phases.remainingId, domIdsCorrect: idsCorrect, jumpPx, remainingPanMs: remainingShift, renderedErrorMs: rendererError(afterPan) },
    );
  }

  // Cancellation must not poison the next fresh gesture.
  start = await resetViewport(page);
  await cancelOneFinger(movingCdp, start.plotRect.left + start.plotRect.width * 0.45, start.plotRect.top + start.plotRect.height / 2);
  await settle(page);
  const afterCancel = await probe(page);
  const recoveryRect = (await currentPlot(page)).plotRect;
  await dispatchTouchSequence(movingCdp, panPoints(recoveryRect, {
    fromX: recoveryRect.width * 0.4, toX: recoveryRect.width * 0.7, steps: 10,
  }));
  await settle(page);
  const recovered = await probe(page);
  const recoveryShift = Math.abs(recovered.renderedViewport.from - afterCancel.renderedViewport.from);
  measurements['cancel-recovery'] = criterion(
    recoveryShift >= span(afterCancel.renderedViewport) * 0.05 && rendererError(recovered) <= 1,
    { recoveryShiftMs: recoveryShift, renderedErrorMs: rendererError(recovered) },
  );

  // Exact phone portrait -> landscape dimensions, followed by another
  // moving-anchor pinch using a rectangle read after rotation. Position the
  // viewport away from the right extent boundary before measuring anchoring.
  await resetViewport(page);
  const orientationPosition = await panRightFromRightEdge(page);
  start = orientationPosition.after;
  await page.setViewportSize({ width: 998, height: 448 });
  await settle(page);
  const landscape = await currentPlot(page);
  const preservedMs = viewportDistance(start.renderedViewport, landscape.renderedViewport);
  const landscapeTime = timeAt(landscape.renderedViewport, 0.4);
  await dispatchTouchSequence(movingCdp, pinchPoints(landscape.plotRect, {
    startGap: 80, endGap: 144, startCenterFraction: 0.4, endCenterFraction: 0.6, steps: 20,
  }));
  await settle(page);
  const landscapeEnd = await probe(page);
  const landscapeDrift = Math.abs(landscapeTime - timeAt(landscapeEnd.renderedViewport, 0.6)) / span(landscapeEnd.renderedViewport) * landscapeEnd.plotRect.width;
  measurements['device-orientation-resize'] = criterion(
    landscape.plotRect.width !== start.plotRect.width && preservedMs <= 1 && landscapeDrift <= 2 && rendererError(landscapeEnd) <= 1,
    { portraitWidth: start.plotRect.width, landscapeWidth: landscape.plotRect.width, preservedMs, anchorDriftPx: landscapeDrift, renderedErrorMs: rendererError(landscapeEnd) },
  );
  await page.setViewportSize({ width: 448, height: 998 });
  await movingCdp.detach();
  return finish(route, measurements);
}

for (const route of candidates) {
  test.describe(route, () => {
    test(`preserves the renderer viewport through equivalent 60-step and 4-step pinches (${route})`, async ({ page }) => {
      const record = await measureRoute(page, route);
      await mkdir(routeResultsDir, { recursive: true });
      await writeFile(path.join(routeResultsDir, `${route}.json`), JSON.stringify(record, null, 2));
    });

    test(`keeps the moving pinch midpoint anchored (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      await panRightFromRightEdge(page);
      const before = await currentPlot(page);
      const anchoredTime = timeAt(before.renderedViewport, 0.4);
      const cdp = await page.context().newCDPSession(page);
      await dispatchTouchSequence(cdp, pinchPoints(before.plotRect, {
        startGap: 80, endGap: 144, startCenterFraction: 0.4, endCenterFraction: 0.6, steps: 20,
      }));
      await settle(page);
      const after = await probe(page);
      const driftPx = Math.abs(anchoredTime - timeAt(after.renderedViewport, 0.6)) / span(after.renderedViewport) * after.plotRect.width;
      expect(driftPx).toBeLessThanOrEqual(2);
      expect(rendererError(after)).toBeLessThanOrEqual(1);
      await cdp.detach();
    });

    test(`continues 1 -> 2 -> 1 without a jump (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      const cdp = await page.context().newCDPSession(page);
      for (const releaseId of [1, 2] as const) {
        await resetViewport(page);
        const phases = partialLiftPhases((await currentPlot(page)).plotRect, releaseId);
        await dispatchTouchSequence(cdp, phases.initialPan);
        await dispatchTouchSequence(cdp, phases.spread);
        await settle(page);
        const before = await probe(page);
        await dispatchTouchSequence(cdp, phases.release);
        await settle(page);
        const released = await probe(page);
        const jumpPx = viewportDistance(before.renderedViewport, released.renderedViewport) / span(before.renderedViewport) * before.plotRect.width;
        await dispatchTouchSequence(cdp, phases.remainingPan);
        await settle(page);
        const after = await probe(page);
        expect(jumpPx).toBeLessThanOrEqual(2);
        expect(Math.abs(after.renderedViewport.from - released.renderedViewport.from)).toBeGreaterThanOrEqual(span(released.renderedViewport) * 0.05);
      }
      await cdp.detach();
    });
  });
}

test.afterAll(async () => {
  const records = await Promise.all(candidates.map(async (route) => {
    const file = path.join(routeResultsDir, `${route}.json`);
    return JSON.parse(await readFile(file, 'utf8')) as RouteResult;
  }));
  const routes = Object.fromEntries(records.map((record) => [record.route, record.criteria]));
  for (const route of candidates) for (const name of SUITABILITY_CRITERIA) {
    const value = routes[route]?.[name];
    if (!value || Object.keys(value.observed).length === 0) throw new Error(`${route}/${name} has no measured result`);
    expect(value.status, `${route}/${name}: ${JSON.stringify(value.observed)}`).toBe('PASS');
  }
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(diagnosticsDir, 'suitability.json'), JSON.stringify({
    criteria: SUITABILITY_CRITERIA,
    routes,
    status: 'PASS',
  }, null, 2));
});
