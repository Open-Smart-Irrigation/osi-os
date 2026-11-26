import type {Simulator} from '@osi-demo/model';
import type {ValvePlan} from '@osi-demo/model/plans';
import type {Command} from '../commands';
import type {OsiAdapter, ReplayHeader, Scenario, ToolId} from '../types';
import type {WeatherSource} from '../weather';
import {World} from '../world';
import {checkWrite} from './allow-list';
import {PhoneBridge, type PhoneDispatcher, type PhoneTraffic} from './bridge';
import {buildFarm, PROBE_EUI} from './farm-builder';
import {createReadingSource} from './reading-source';
import {advanceOsi, drainNow} from './stepping';
import type {DemoResponse} from './types';
import {WaterTap} from './water-tap';
import {createWeatherSource} from './weather-source';

interface AdapterOptions {
  dispatcher: PhoneDispatcher;
  weather?: WeatherSource;
  sensorNoise?: boolean;
  logPhoneTraffic?: (event: PhoneTraffic) => void;
}

export class FarmOsiAdapter implements OsiAdapter {
  private farm?: {tier: ReplayHeader['tier']; sim: Simulator; world: World; water: WaterTap; bridge: PhoneBridge};

  constructor(private readonly options: AdapterOptions) {}

  private get built() {
    if (!this.farm) throw new Error('Build the farm before using the OSI adapter');
    return this.farm;
  }

  build(header: ReplayHeader, scenario: Scenario): void {
    const world = new World(header, scenario, this.options.weather);
    const sim = buildFarm(header, scenario, {
      readingSource: createReadingSource(world, header.start, header.seed, this.options.sensorNoise ?? true),
      weatherSource: createWeatherSource(world.weather),
    });
    const water = new WaterTap(sim, world);
    if (header.tier >= 3) world.attachValveTap(water);
    const bridge = new PhoneBridge(sim, header.tier, this.options.dispatcher, this.options.logPhoneTraffic);
    this.farm = {tier: header.tier, sim, world, water, bridge};
    this.drainNow();
  }

  get world(): World { return this.built.world; }
  get now(): number { return this.built.sim.now; }
  get clockRevision(): number { return this.built.sim.clock.revision; }

  advance(simMs: number): void {
    const {sim, world, water} = this.built;
    advanceOsi(sim, world, water, simMs);
  }

  drainNow(): void {
    const {sim, world, water, bridge} = this.built;
    drainNow(sim, world, water);
    bridge.invalidate();
  }

  litersBetween(zoneId: number, from: number, to: number) {
    return this.built.water.litersBetween(zoneId, from, to);
  }

  drain() { return this.built.water.drain(); }

  request(method: string, path: string, body: unknown = undefined): DemoResponse {
    return this.built.bridge.request(method, path, body);
  }

  /** Called by the single Run dispatcher, which logs the command and then drains the instant. */
  executePhoneWrite(command: Extract<Command, {kind: 'phoneRequest'}>): DemoResponse {
    if (command.simNow !== this.now) throw new Error('Phone write must dispatch at the current simulator instant');
    const {tier, sim} = this.built;
    // Loaded saves also use this entry point. Validate their writes before entering the simulator.
    const result = checkWrite(tier, command.method, command.path, command.body);
    if ('code' in result || !this.isPhoneOpen()) throw new Error('Invalid dispatched phone write');
    return sim.requestResponse(command.method, command.path, result.body);
  }

  setPhoneOpen(open: boolean): void { this.built.bridge.setOpen(open); }
  isPhoneOpen(): boolean { return this.built.bridge.isOpen(); }
  phoneNow(): number { return this.built.bridge.now(); }
  phoneStats() { return this.built.bridge.stats(); }

  resetEnvironmentRecords(): void {
    this.built.sim.resetEnvironmentRecords();
    this.built.bridge.invalidate();
  }

  viewModel(selectedTool?: ToolId) {
    const {sim, world, water, bridge} = this.built;
    return world.viewModel(sim.now, {selectedTool, phoneOpen: bridge.isOpen(), ...water.view()});
  }

  /** Detached inputs to the simulator portion of the replay checkpoint digest (plan 4.8). */
  simulatorSnapshot() {
    return structuredClone(this.simulatorDigestInputs());
  }

  /**
   * The same inputs as `simulatorSnapshot()`, but the containers hold the simulator's live objects (readings excepted:
   * `forDevice` already copies them). The checkpoint digest serialises them at once and never keeps them. They are
   * plain objects and arrays, so `JSON.stringify` writes the same bytes as for the detached copy, without the cost of
   * copying the state at every checkpoint; tests/integration/checkpoint-digest.test.ts guards that.
   */
  simulatorDigestInputs() {
    const {sim} = this.built;
    return {
      zones: sim.zones, devices: sim.devices, outcomes: sim.outcomes,
      triggerEvaluations: sim.state.triggerEvaluations,
      readings: sim.devices.map(device => [device.deveui, sim.readings.forDevice(device.deveui)] as const),
      environmentRecords: [...sim.state.environmentRecords], schedules: [...sim.state.schedules],
      valveSettings: [...sim.state.valveSettings], activeCommands: [...sim.state.activeCommands], clockIds: sim.clock.ids(),
    };
  }

  /** Live, read-only zones (each with its trigger schedule), for per-tick readers that need no detached copy. */
  zones(): readonly Readonly<Simulator['zones'][number]>[] { return this.built.sim.zones; }

  /** Live, read-only valve plans by valve EUI (`sim.state.schedules`), for per-tick readers that need no detached copy. */
  valvePlans(): ReadonlyMap<string, readonly Readonly<ValvePlan>[]> { return this.built.sim.state.schedules; }

  latestProbeSample() { return this.built.sim.readings.latestSample(PROBE_EUI); }
  probeSamples() { return this.built.sim.readings.forDevice(PROBE_EUI); }
  triggerEvaluations() { return this.built.sim.state.triggerEvaluations; }

  waterSnapshot() { return this.built.water.snapshot(); }
}
