import {render} from 'preact';
import {FARM_SITES, BED_A_AREA_M2} from './core/map';
import {createRun, loadRun, type FarmRun} from './core/replay';
import {defaultHeader, scenarioById, SCENARIOS} from './core/scenario';
import {irrigationLiters} from './core/report';
import {rollingTransplant} from './core/tutorial';
import type {ReplayHeader, TileRef} from './core/types';
import {inputController} from './input/controller';
import {startLoop} from './loop';
import {createReplayFileLoader} from './replay-file';
import {SleepJump} from './sleep-jump';
import {createFarmRenderer} from './view/renderer';
import {download, LogExport} from './ui/export';
import {FarmHud, frameDelta, GameControls, PhoneControls, ToolBelt} from './ui/game';
import {tutorialHint} from './ui/hints';
import {About, Bedtime, Facilitator, Report} from './ui/overlays';
import {createPhoneHost, type PhoneHost} from './phone-host';

const BUILD = import.meta.env.PROD ? new URL(import.meta.url).pathname.split('/').pop()! : 'm1-dev';

export async function bootGame(root: HTMLElement, facilitator: boolean) {
  const scene = document.createElement('div');
  scene.id = 'farm-scene';
  const phone = document.createElement('div');
  phone.id = 'farm-phone';
  phone.hidden = true;
  const ui = document.createElement('div');
  ui.id = 'farm-ui';
  root.append(scene, phone, ui);
  const generated = new URL('generated/', document.baseURI);
  const renderer = await createFarmRenderer(scene, generated);
  // ?perf loads the section 12 probe for tests/e2e/perf.spec.ts; without it nothing extra loads.
  if (new URLSearchParams(location.search).has('perf')) (await import('./render-review')).installPerfProbe(renderer);
  const toolIcon = Object.fromEntries(['hoe', 'seedling', 'can', 'jerrycan', 'basket'].map(tool => {
    const {frame, image, width, height} = renderer.atlasRegion('icon.' + tool);
    return [tool, {
      backgroundImage: 'url("' + new URL(image, generated).href + '")',
      backgroundPosition: `-${frame.x * 2}px -${frame.y * 2}px`,
      backgroundSize: `${width * 2}px ${height * 2}px`,
    }] as const;
  }));

  let run: FarmRun;
  let host: PhoneHost;
  let eventExport: LogExport;
  let panel: 'facilitator' | 'about' | undefined = facilitator ? 'facilitator' : undefined;
  let problem: string | undefined;
  let sleep: {until: number; expectedCount: number; dispatched: boolean; jump?: SleepJump} | undefined;
  let roll: TileRef | undefined;
  let revision: number;
  let session = 0;
  const togglePhone = () => {
    if (panel || sleep || (run.complete && !run.isPhoneOpen()) || run.header.tier === 0) return;
    input.clear();
    run.apply({kind: run.isPhoneOpen() ? 'phoneClose' : 'phoneOpen'});
  };
  const controls = () => !!run.pendingWork || panel !== undefined || sleep !== undefined || run.isPhoneOpen() || run.complete;
  const input = inputController(renderer.canvas, {
    view: () => run.viewModel(), send: cmd => run.apply(cmd), isBlocked: controls, openPhone: togglePhone,
    sleep() {
      if (!run.viewModel().hud.canSleep) return;
      input.clear();
      sleep = {until: performance.now() + 220, expectedCount: run.feedback().sleepCount + 1, dispatched: false};
    },
    toggleFacilitator() {
      if (run.pendingWork || sleep || run.isPhoneOpen()) return;
      input.clear();
      panel = panel === 'facilitator' ? undefined : 'facilitator';
    },
  });

  function start(next: FarmRun) {
    host?.dispose();
    input.clear();
    input.select('can');
    run = next;
    eventExport = new LogExport(run.header, performance.now());
    host = createPhoneHost(phone, next, {language: new URLSearchParams(location.search).get('lang') ?? 'en'});
    roll = undefined;
    sleep = undefined;
    revision = run.phoneRevision;
    problem = undefined;
    session++;
  }

  start(createRun(defaultHeader(BUILD)));
  const close = () => { panel = undefined; problem = undefined; };
  const restart = () => { close(); start(createRun(run.header)); };
  const exportLog = () => download('farm-log.jsonl', eventExport.jsonl(), 'application/x-ndjson');
  const exportSave = () => download('farm-replay.json', JSON.stringify(run.save()), 'application/json');
  const load = createReplayFileLoader({
    build: BUILD,
    session: () => session,
    load(save) {
      start(loadRun(save));
      eventExport.replayLoad(run.eventsSince(0), run.now, performance.now());
      close();
    },
    fail(message) { problem = message; },
  });

  // Resume behind the last complete view. Posted messages give each slice its own browser task
  // without waiting a display frame per batch of readings.
  const continuation = new MessageChannel();
  function advanceSleep() {
    if (!sleep?.jump) return;
    if (sleep.jump.advance()) {
      sleep.dispatched = true;
      if (run.feedback().sleepCount !== sleep.expectedCount) sleep = undefined;
    } else continuation.port2.postMessage(null);
  }
  continuation.port1.onmessage = () => {
    if (sleep?.jump && !sleep.dispatched) {
      advanceSleep();
      return;
    }
    const deadline = performance.now() + 3;
    for (let chunk = 0; chunk < 4; chunk++) {
      if (run.resumeStep()) return;
      if (performance.now() >= deadline) break;
    }
    continuation.port2.postMessage(null);
  };
  let deferredMs = 0;
  startLoop((now, delta, elapsed, quality) => {
    if (run.pendingWork) {
      deferredMs += delta;
      return;
    }
    if (sleep && !sleep.dispatched && now >= sleep.until) {
      if (!sleep.jump) {
        sleep.jump = new SleepJump(run);
        advanceSleep();
      }
      // Keep the last complete view on screen until the posted sleep tasks reach wake-up.
      return;
    }
    input.update(now);
    const realMs = frameDelta(delta + deferredMs, panel, sleep !== undefined);
    deferredMs = 0;
    if (!run.step(realMs, true)) {
      continuation.port2.postMessage(null);
      return;
    }
    const feedback = run.feedback();
    eventExport.receive(run.eventsSince(eventExport.sequence), now);
    const vm = run.viewModel();
    if (vm.phoneOpen !== host.isOpen()) {
      if (vm.phoneOpen) host.raise();
      else host.lower();
    }
    if (revision !== run.phoneRevision) host.notify(sleep?.dispatched);
    revision = run.phoneRevision;
    renderer.render(vm, elapsed, quality);

    if (vm.sky.day === 2) roll ??= rollingTransplant(vm);
    const hints = vm.hud.sliceComplete || !run.header.hints || !feedback.tutorial.enabled
      ? undefined : tutorialHint(vm, feedback, roll);
    const pickedKg = vm.daily.reduce((value, day) => value + day.pickedKg, vm.today.pickedKg);
    const used = vm.daily.reduce((value, day) => value + irrigationLiters(day), irrigationLiters(vm.today));
    render(<>
      <FarmHud vm={vm} pickedKg={pickedKg} used={used} about={() => {
        if (!run.pendingWork && !run.isPhoneOpen() && !sleep) { input.clear(); panel = 'about'; }
      }} />
      {!controls() && <>
        <ToolBelt vm={vm} icons={toolIcon} selected={input.selected} select={tool => input.select(tool)} />
        <GameControls vm={vm} feedback={feedback} hint={hints} sites={FARM_SITES} target={input.target}
          openPhone={togglePhone} direction={input.setStick} useSelected={input.useSelected} />
      </>}
      {vm.phoneOpen && <>
        <PhoneControls lower={togglePhone} />
        {feedback.report && <div class="field-note phone-notice" role="status">
          game · Lower the phone to see the farm report.
        </div>}
      </>}
      {panel === 'about' && <About tier={vm.tier} area={BED_A_AREA_M2} close={close} />}
      {panel === 'facilitator' && <Facilitator key={session} header={run.header} scenarios={SCENARIOS}
        close={close} exportLog={exportLog} exportSave={exportSave} load={file => { void load(file); }} problem={problem}
        start={draft => {
          const header: ReplayHeader = {...defaultHeader(BUILD, scenarioById(draft.scenario), draft.tier),
            pace: draft.pace, hints: draft.hints, pauseWhilePhoneOpen: draft.pauseWhilePhoneOpen, moistureLens: draft.moistureLens};
          start(createRun(header));
          close();
        }} />}
      {sleep && <div class="sleep-screen">{sleep.dispatched && feedback.bedtime &&
        <Bedtime card={feedback.bedtime} close={() => { sleep = undefined; }} />}</div>}
      {feedback.report && !sleep && !panel && !vm.phoneOpen && <Report report={feedback.report} restart={restart} exportLog={exportLog} />}
    </>, ui);
  });
}
