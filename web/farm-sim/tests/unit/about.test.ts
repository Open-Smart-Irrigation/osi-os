import assert from 'node:assert/strict';
import test from 'node:test';
import {BED_A_AREA_M2} from '../../src/core/map';
import {createRun} from '../../src/core/replay';
import {defaultHeader} from '../../src/core/scenario';
import {frameDelta} from '../../src/ui/game';
import {About} from '../../src/ui/overlays';

/** Joins the text children of a Preact element tree without rendering it. */
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const {props} = node;
    return typeof props === 'object' && props !== null && 'children' in props ? text(props.children) : '';
  }
  return '';
}

test('the T4 About panel says a trigger on one sensor reads only that depth', () => {
  const sentence = 'A trigger on one sensor reads only that depth, so a run that is too short can keep that depth wet while the soil below it dries.';
  const about = (tier: 3 | 4) => text(About({tier, area: BED_A_AREA_M2, close: () => undefined}));
  assert.ok(about(4).includes(sentence));
  assert.ok(!about(3).includes(sentence));
});

test('game time stops and nothing is logged while the About panel, the facilitator panel or the sleep screen is up', () => {
  const run = createRun(defaultHeader('tests'));
  const start = run.now;
  const records = run.eventsSince(0).length;
  for (const [panel, sleeping] of [['about', false], ['facilitator', false], [undefined, true]] as const) {
    run.step(frameDelta(100, panel, sleeping));
  }
  assert.equal(run.now, start);
  assert.equal(run.eventsSince(0).length, records);
  assert.deepEqual(run.save().log, []);
  run.step(frameDelta(100, undefined, false));
  assert.ok(run.now > start);
});
