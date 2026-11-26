import {sampleIntervalMs, type ReadingSource} from '@osi-demo/model/readings';
import {namedStream, normal} from '../rng';
import {layerKpa} from '../soil';
import {MINUTE_MS} from '../time';
import {round2} from '../units';
import type {World} from '../world';

export function createReadingSource(world: World, start: number, seed: number, noise: boolean): ReadingSource {
  return (device, at) => {
    world.stepTo(at);
    const bat_pct = world.sensorBatteryPct(device.type_id);
    switch (device.type_id) {
      case 'KIWI_SENSOR': {
        const column = world.bedAColumn(at);
        const draw = namedStream(seed, 'sensorNoise', device.deveui, at);
        const reading = (layer: number) => {
          const kPa = layerKpa(column, layer, false);
          const error = noise ? normal(draw) * Math.max(.5, .05 * kPa) : 0;
          return round2(Math.max(0, Math.min(200, kPa + error)));
        };
        return {swt_1: reading(1), swt_2: reading(2), bat_pct};
      }
      case 'DRAGINO_LSN50': {
        const from = Math.max(start, at - sampleIntervalMs());
        const rain = world.rainMmBetween(from, at);
        const liters = world.manualTapLitersBetween(from, at);
        const per10 = (delta: number) => at > from ? round2(delta * 10 * MINUTE_MS / (at - from)) : 0;
        return {rain_mm_delta: rain, rain_mm_per_10min: per10(rain), flow_liters_delta: liters,
          flow_liters_per_10min: per10(liters), lsn50_mode_label: 'MOD9', lsn50_mode_code: 9, bat_pct};
      }
      case 'STREGA_VALVE':
        return {valve_state: device.current_state === 'OPEN' ? 1 : 0, bat_pct};
      default:
        throw new Error('Unexpected device in the farm reading source');
    }
  };
}
