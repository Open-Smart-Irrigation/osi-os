import assert from 'node:assert/strict';
import test from 'node:test';
import type {ComponentChildren, FunctionComponent, VNode} from 'preact';
import {sliceReport} from '../../src/core/report';
import type {WorldDayView} from '../../src/core/types';
import {Report} from '../../src/ui/overlays';

/** Renders a hook-free component tree to its text, one string per table cell or paragraph. */
function texts(node: ComponentChildren): string[] {
  const out: string[] = [];
  const walk = (child: ComponentChildren, into: string[]): void => {
    if (child === null || child === undefined || typeof child === 'boolean') return;
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint') {
      into.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) walk(item, into);
      return;
    }
    const vnode = child as VNode;
    if (typeof vnode.type === 'function') {
      walk((vnode.type as FunctionComponent)(vnode.props), into);
      return;
    }
    if (['td', 'th', 'p'].includes(vnode.type)) {
      const parts: string[] = [];
      walk(vnode.props.children, parts);
      out.push(parts.join(''));
    } else walk(vnode.props.children, into);
  };
  walk(node, out);
  return out;
}

const base: WorldDayView = {
  date: '2027-01-11', at: 0, rainMm: 0, irrigationLiters: {can: 0, tap: 0, valve: 360},
  runoffLiters: 0, percolationLiters: 0, applicationLossLiters: 0, waterEnergy: 0,
  pumpStrokes: 18, carryTrips: 2, soilWaterMm: {start: 152.1, end: 150.5},
  waterMinutes: 0, meanKs: 1, stressDay: false, pickedKg: 1.7, lostKg: 0,
  waterProductivityKgPerM3: null, cutoffs: [],
};
const days = Array.from({length: 15}, (_, i): WorldDayView => ({
  ...base, date: '2027-01-' + (11 + i), at: 1_000 * (i + 1),
  soilWaterMm: {start: 152.1 - i, end: 151.1 - i},
}));
// The soil trigger opens the valve once a day.
const report = (tier: 3 | 4) => sliceReport({daily: days.slice(0, 14), today: days[14]},
  days.map(record => ({trigger: 'trigger_based', openedAt: record.at - 500})), {scenario: 'baseline', tier});
const view = (tier: 3 | 4) =>
  texts(Report({report: report(tier), restart() {}, exportLog() {}}));

test('the slice report shows strokes, shared-well trips and bed A root-zone water per day and in total', () => {
  const cells = view(3);
  assert.ok(cells.includes('Pump strokes / shared-well trips'));
  assert.ok(cells.includes('Bed A root zone, start / end (mm)'));
  const header = cells.indexOf('Farm date');
  const litres = cells.indexOf('Can / tap / valve (L)');
  assert.equal(cells.indexOf('Pump strokes / shared-well trips'), litres + 1);
  const first = cells.indexOf('2027-01-11');
  assert.ok(first > header);
  assert.equal(cells[first + 2], '0 / 0 / 360');
  assert.equal(cells[first + 3], '18 / 2');
  assert.equal(cells[first + 6], '152.1 / 151.1');
  const total = cells.indexOf('Total');
  assert.equal(cells[total + 3], '270 / 30');
  assert.equal(cells[total + 6], '152.1 / 137.1');
});

// Council r2, Fable S13: the stress days count bed A only (plan 7.5), while bed B can wilt on day 2.
test('the slice report labels the stress-day column and total as bed A\'s', () => {
  const cells = view(3);
  assert.equal(cells.indexOf('Bed A stress days'), cells.indexOf('Bed A root zone, start / end (mm)') + 1);
  assert.equal(cells.filter(text => /stress days/i.test(text) && !/bed A stress days/i.test(text)).length, 0);
  assert.equal(cells.filter(text => /^[\d.]+ kg picked · 0 bed A stress days$/.test(text)).length, 1);
});

test('the slice report adds the timer comparison at T4 only', () => {
  const sentence = /^The soil-triggered valve watered on 14 of the 14 days and the daily timer \(reference run, same weather\) on 14: /;
  const comparison = view(4).filter(text => sentence.test(text));
  assert.equal(comparison.length, 1);
  // One paragraph holds both sentences; the run made 28 shared-well trips, the baseline timer none.
  assert.match(comparison[0], / and 28 trips to the shared well against none\. The root zone ended \d+ mm drier, about [\d,]+ L the soil has lent\.$/);
  assert.equal(view(3).filter(text => text.includes('daily timer (reference run')).length, 0);
});

test('the slice report shows the sentence core built into the report', () => {
  const shown = texts(Report({report: {...report(4), comparison: 'Core wrote this sentence.'}, restart() {}, exportLog() {}}));
  assert.ok(shown.includes('Core wrote this sentence.'));
  assert.equal(shown.filter(text => text.includes('daily timer (reference run')).length, 0);
});
