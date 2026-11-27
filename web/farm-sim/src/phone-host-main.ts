// WP5 host for the production phone. The game loop can use createPhoneHost with its own dispatcher.
import type {Command} from './core/commands';
import {FarmOsiAdapter} from './core/osi/adapter';
import type {PhoneTraffic} from './core/osi/bridge';
import {defaultHeader, TUTORIAL_SCENARIO} from './core/scenario';
import {MINUTE_MS, SECOND_MS, nextLocalMidnight} from './core/time';
import type {Tier} from './core/types';
import {createPhoneHost} from './phone-host';
import './phone-host.css';

const params = new URLSearchParams(location.search);
const tier = Number(params.get('tier') ?? '4');
if (!TUTORIAL_SCENARIO.tiers.includes(tier as Tier)) throw new RangeError('Unknown OSI tier');

const probe = params.has('probe');
const log: (PhoneTraffic | Extract<Command, {kind: 'phoneRequest'}>)[] = [];
let seq = 0;
const adapter: FarmOsiAdapter = new FarmOsiAdapter({
  dispatcher: {
    dispatchQueued() {}, // The host has no queued player commands.
    dispatchPhone(write) {
      const command = {...write, simNow: adapter.now, seq: ++seq};
      const response = adapter.executePhoneWrite(command);
      if (probe) log.push(command);
      adapter.drainNow();
      return response;
    },
  },
  logPhoneTraffic: probe ? event => log.push(event) : undefined,
});
adapter.build(defaultHeader('phone', TUTORIAL_SCENARIO, tier as Tier), TUTORIAL_SCENARIO);
if (params.has('near-midnight')) {
  const minutes = params.get('near-midnight') === 'late' ? -90 : 30;
  adapter.advance(nextLocalMidnight(adapter.now) + minutes * MINUTE_MS);
}

const slot = document.getElementById('phone-slot')!;
const toggle = document.querySelector<HTMLButtonElement>('#phone-toggle')!;
const drip = document.getElementById('drip-status')!;
const phone = createPhoneHost(slot, adapter, {language: params.get('lang') ?? 'en'});
toggle.disabled = tier === 0;
toggle.addEventListener('click', () => {
  const open = !adapter.isPhoneOpen();
  adapter.setPhoneOpen(open);
  if (adapter.isPhoneOpen()) phone.raise();
  else phone.lower();
  toggle.textContent = open ? 'Lower phone' : 'Raise phone';
  toggle.setAttribute('aria-expanded', String(open));
});

function advance(ms: number) {
  adapter.advance(adapter.now + ms);
  drip.textContent = adapter.viewModel().dripLine.some(tile => tile.wet) ? 'Drip line running' : 'Drip line idle';
  phone.notify(true);
}
document.getElementById('advance')!.addEventListener('click', () => advance(3 * SECOND_MS));

export interface PhoneHostProbe {
  now(): number;
  stats(): ReturnType<FarmOsiAdapter['phoneStats']>;
  log: typeof log;
  advance(ms: number): void;
  revalidate(keys: readonly string[]): void;
  snapshot(): string;
}

declare global {
  interface Window {
    __farmSim?: PhoneHostProbe;
  }
}

if (probe) {
  window.__farmSim = {
    now: () => adapter.now,
    stats: () => adapter.phoneStats(),
    log,
    advance,
    revalidate: phone.revalidate,
    snapshot: () => JSON.stringify(adapter.simulatorSnapshot()),
  };
}
