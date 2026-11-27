import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {Sprite, Texture, TextureSource} from 'pixi.js';
import {bakeAtlas} from '../../scripts/bake-atlas';
import {defaultHeader} from '../../src/core/scenario';
import {createRun} from '../../src/core/replay';
import {START_TILE} from '../../src/core/map';
import {loopProbe} from '../../src/loop';
import {advanceUntil, evening, house, queueWalk} from '../integration/run-replay-session';
import {installPerfProbe, makeReview, wrapCore} from '../../src/render-review';
import {Actors} from '../../src/view/actors';
import {FarmAtlas} from '../../src/view/atlas';
import {lightingAt} from '../../src/view/lighting';
import {TerrainChunk} from '../../src/view/terrain-layer';
import type {ViewModel} from '../../src/view/view-model';

function animationClock(t: TestContext, intervalMs: number) {
  t.mock.method(performance, 'now', () => 0);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  let timestamp = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value(callback: FrameRequestCallback) {
      queueMicrotask(() => callback(timestamp += intervalMs));
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'requestAnimationFrame', previous);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  });
}

test('a fixed noon capture uses the same player texture before and after a benchmark', async t => {
  animationClock(t, 2_010);
  const {atlas: data} = bakeAtlas();
  const page = new Texture({source: new TextureSource({width: data.width, height: data.height})});
  const atlas = new FarmAtlas(data, page);
  const actors = new Actors(atlas);
  t.after(() => {
    actors.sprites.destroy({children: true});
    actors.shadows.destroy({children: true});
    actors.pipes.destroy({children: true});
    actors.destroy();
    atlas.destroy();
    page.destroy(true);
  });
  const idle = data.clips.player.down.idle.map(id => atlas.texture(id));
  const rendered: number[] = [];
  let liveView: ViewModel | undefined;
  const renderer: Parameters<typeof makeReview>[0] = {render(vm, ms, _quality, playerElapsedMs) {
    actors.sync(vm, lightingAt(vm.sky), ms, playerElapsedMs);
    const player = actors.sprites.children.find(child => child instanceof Sprite && idle.includes(child.texture));
    assert.ok(player instanceof Sprite);
    rendered.push(idle.indexOf(player.texture));
    if (ms === 2_010) liveView = vm;
    return true;
  }};
  const review = makeReview(renderer, defaultHeader('test'));
  const noon = review.frame('noon');
  await review.benchmark(100);
  assert.deepEqual(review.frame('noon'), noon);
  assert.deepEqual(rendered, [0, 0, 0], 'noon player texture depends on the previous benchmark');
  assert.ok(liveView);
  renderer.render(liveView, 2_510);
  assert.equal(rendered[3], 1, 'fixed capture reset the live animation');
});

for (const {interval, sleep, rain} of [
  {interval: 750, sleep: false, rain: false},
  {interval: 600, sleep: true, rain: false},
  {interval: 50, sleep: true, rain: true},
]) {
  test(`a 60-second benchmark reports the phases rendered at a ${interval} ms callback interval`, async t => {
    animationClock(t, interval);
    let sawWake = false;
    let sawRain = false;
    const review = makeReview({render(vm) {
      sawWake ||= vm.sky.day === 2 && vm.sky.hour >= 5 && vm.sky.hour < 7;
      sawRain ||= vm.sky.raining;
      return true;
    }}, defaultHeader('test'));
    const result = await review.benchmark(60_000);
    assert.ok(result.frames > 0);
    assert.deepEqual({sleep: sawWake, rain: sawRain}, {sleep, rain});
    assert.deepEqual(result.phases, {sleep, rain});
  });
}

test('the interactive probe counts each tick once and times checkpoint slices', t => {
  const probe = wrapCore();
  const run = createRun({...defaultHeader('probe'), tier: 4});
  probe.bypassed(() => {
    queueWalk(run, START_TILE, house);
    advanceUntil(run, evening);
    run.apply({kind: 'sleep'});
    run.step(0);
  });
  assert.equal(run.feedback().sleepCount, 1);
  let clock = 0;
  t.mock.method(performance, 'now', () => ++clock);
  probe.state.window = 'play';
  t.after(() => { probe.state.window = undefined; });
  probe.takeFrame();
  let checkpointSlices = 0;
  for (let i = 0; i < 75; i++) {
    run.step(400, true);
    while (run.pendingWork) {
      checkpointSlices++;
      run.resumeStep();
    }
  }
  assert.equal(probe.takeFrame().ticks, 600);
  assert.equal(probe.state.advances.length, 600);
  const uplinks = probe.state.advances.filter(advance => advance.uplink);
  assert.ok(uplinks.length > 0);
  assert.equal(probe.state.work.filter(span => span.name === 'uplink advance').length, uplinks.length);
  assert.ok(checkpointSlices > 1);
  assert.equal(probe.state.work.filter(span => span.name === 'checkpoint hash').length, checkpointSlices);
  const stepMs = probe.state.work.filter(span => span.name === 'core step').reduce((total, span) => total + span.ms, 0);
  assert.deepEqual(probe.state.playCore, {ms: stepMs + checkpointSlices, ticks: 600});
});

test('the standalone benchmark records no samples or completed render phases when draws are skipped', async t => {
  animationClock(t, 50);
  const review = makeReview({render: () => false}, defaultHeader('test'));
  const result = await review.benchmark(60_000);
  assert.ok(result.ticks >= 960);
  assert.equal(result.frames, 0);
  assert.deepEqual(result.phases, {sleep: false, rain: false});
});

test('the interactive probe flags only callbacks that drew the farm', t => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {}});
  const previousFrame = loopProbe.frame;
  const rebake = TerrainChunk.prototype.rebake;
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    loopProbe.frame = previousFrame;
    TerrainChunk.prototype.rebake = rebake;
  });
  let draws = false;
  const renderer = {render: () => draws};
  installPerfProbe(renderer);
  const probe = window.farmPerf!;
  probe.begin('play');
  assert.equal(renderer.render(), false);
  loopProbe.frame?.(0, 1, 'standard');
  draws = true;
  assert.equal(renderer.render(), true);
  loopProbe.frame?.(16, 18, 'standard');
  loopProbe.frame?.(32, 33, 'standard');
  probe.end();
  assert.deepEqual(probe.snapshot().frames.map(frame => frame.rendered), [false, true, false]);
});
