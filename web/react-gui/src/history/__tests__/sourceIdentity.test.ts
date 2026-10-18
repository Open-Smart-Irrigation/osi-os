import { describe, expect, it } from 'vitest';
import {
  classifyHistoryChannel,
  displayHistorySeriesLabel,
  historySeriesColor,
  historySeriesValue,
} from '../sourceIdentity';

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
});
