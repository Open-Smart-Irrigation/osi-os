import {defaultHeader, TUTORIAL_SCENARIO} from './core/scenario';
import {World} from './core/world';
import {createFarmRenderer} from './view/renderer';
import {FrameQuality, frameSlot} from './view/quality';

function startAnimation(draw: (elapsed: number, tier: FrameQuality['current']) => void) {
  const memory = (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
  const quality = new FrameQuality(memory);
  let start: number | undefined;
  let lastSlot = -1;
  function frame(now: number) {
    start ??= now;
    const elapsed = now - start;
    const slot = frameSlot(elapsed, quality.current);
    if (slot > lastSlot) {
      const before = performance.now();
      const tier = quality.current;
      draw(elapsed, tier);
      quality.observe(now, performance.now() - before);
      lastSlot = frameSlot(elapsed, quality.current);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

export async function bootDemo(mount: HTMLElement) {
  const renderer = await createFarmRenderer(mount, new URL('generated/', document.baseURI));
  const header = defaultHeader('wp7');
  if (new URLSearchParams(location.search).has('render-review')) {
    const {makeReview} = await import('./render-review');
    window.farmRenderReview = makeReview(renderer, header);
    return;
  }
  const world = new World(header, TUTORIAL_SCENARIO);
  const baseline = world.viewModel(header.start);
  startAnimation((elapsed, tier) => renderer.render(baseline, elapsed, tier));
}
