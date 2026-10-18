import { describe, expect, it } from 'vitest';
import {
  classifyHistoryChannel,
  displayHistorySeriesLabel,
  historySeriesColor,
  historySeriesStyles,
  historySeriesValue,
} from '../sourceIdentity';
import { historySourceChoicesFromSeries } from '../sourceSelection';

describe('history source identity', () => {
  it('classifies by channel key and keeps explicit null values', () => {
    expect(classifyHistoryChannel('swt_1')).toBe('soil');
    expect(classifyHistoryChannel('vwc')).toBe('soil');
    expect(classifyHistoryChannel('ambient_temperature')).toBe('environment');
    expect(historySeriesValue({ value: null, mean: 42 })).toBeNull();
    expect(historySeriesValue({ mean: 42 })).toBe(42);
  });

  it('disambiguates equal source labels and depths with the stable physical id', () => {
    const a = { id: 'device-a:swt_1', deviceSourceId: 'device-a', sourceLabel: 'Probe', depthCm: 20 };
    const b = { id: 'device-b:swt_1', deviceSourceId: 'device-b', sourceLabel: 'Probe', depthCm: 20 };
    expect(displayHistorySeriesLabel({ ...a, channelKey: 'swt_1' }, [{ ...a, channelKey: 'swt_1' }, { ...b, channelKey: 'swt_2' }])).toBe('Probe · SWT 1 · 20 cm');
    expect(displayHistorySeriesLabel({ ...b, channelKey: 'swt_2' }, [{ ...a, channelKey: 'swt_1' }, { ...b, channelKey: 'swt_2' }])).toBe('Probe · SWT 2 · 20 cm');
  });

  it('derives color from stable series identity', () => {
    expect(historySeriesColor('device-a:swt_1')).toBe(historySeriesColor('device-a:swt_1'));
    expect(historySeriesColor('device-a:swt_1')).not.toBe(historySeriesColor('device-b:swt_1'));
    expect(historySeriesColor('device-537a49c74508:swt_1')).not.toBe(historySeriesColor('device-2b53ef351e8a:swt_1'));
  });

  it('probes colliding color and dash candidates without depending on input order', () => {
    const ids = ['device-000000000216:swt_1', 'device-0000000002cd:swt_1'];
    const first = historySeriesStyles(ids);
    const second = historySeriesStyles([...ids].reverse());
    expect(first.get(ids[0])).not.toEqual(first.get(ids[1]));
    expect(first.get(ids[0])?.color.match(/^hsl\((\d+)/)?.[1] !== first.get(ids[1])?.color.match(/^hsl\((\d+)/)?.[1]
      || first.get(ids[0])?.dash !== first.get(ids[1])?.dash).toBe(true);
    expect(second).toEqual(first);
  });

  it('terminates with unique perceptible candidates for a large concurrent set', () => {
    const ids = Array.from({ length: 1200 }, (_, index) => `same-hue-source-${index.toString(16).padStart(4, '0')}`);
    const styles = historySeriesStyles(ids);
    const keys = ids.map((id) => {
      const style = styles.get(id)!;
      return `${style.color}|${style.dash}`;
    });
    expect(styles.size).toBe(ids.length);
    expect(new Set(keys).size).toBe(ids.length);
  });

  it('disambiguates duplicate recovery choices by stable source key', () => {
    expect(historySourceChoicesFromSeries([
      { sourceKey: 'soil-src-one', sourceLabel: 'Soil sensor', deviceSourceId: 'device-a' },
      { sourceKey: 'soil-src-two', sourceLabel: 'Soil sensor', deviceSourceId: 'device-b' },
      { sourceKey: 'soil-src-one', sourceLabel: 'Soil sensor', deviceSourceId: 'device-a' },
    ])).toEqual([
      { sourceKey: 'soil-src-one', label: 'Soil sensor · -src-one', deviceSourceId: 'device-a' },
      { sourceKey: 'soil-src-two', label: 'Soil sensor · -src-two', deviceSourceId: 'device-b' },
    ]);
  });
});
