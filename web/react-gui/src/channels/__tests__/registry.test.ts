import { describe, expect, it } from 'vitest';
import {
  cardChannels,
  cardChannelsForSource,
  canonicalize,
  channelLabel,
  channelUnit,
  createChannelRegistry,
} from '../registry';

describe('channel registry', () => {
  it('cardChannels returns canonical exportable channels per card type', () => {
    expect(cardChannels('soil')).toEqual(['swt_1', 'swt_2', 'swt_3', 'vwc']);
    expect(cardChannels('irrigation')).toEqual([]);
    expect(cardChannels('gateway')).toEqual([]);
  });

  it('cardChannelsForSource applies device-aware defaults', () => {
    expect(cardChannelsForSource('soil', { chameleonEnabled: true })).toEqual(['swt_1', 'swt_2', 'swt_3']);
    expect(cardChannelsForSource('environment', { deviceType: 'DRAGINO_LSN50', tempEnabled: true })).toEqual([
      'ext_temperature_c',
    ]);
    expect(cardChannelsForSource('environment', { deviceType: 'KIWI_SENSOR' })).toEqual([
      'ambient_temperature',
      'relative_humidity',
      'light_lux',
    ]);
    expect(cardChannelsForSource('soil', { deviceType: 'DRAGINO_SDI12' })).toEqual([
      'swt_1', 'swt_2', 'swt_3',
      'vwc_1', 'vwc_2', 'vwc_3', 'vwc_4', 'vwc_5', 'vwc_6', 'vwc_7', 'vwc_8',
      'soil_temp_1', 'soil_temp_2', 'soil_temp_3', 'soil_temp_4', 'soil_temp_5', 'soil_temp_6', 'soil_temp_7', 'soil_temp_8',
      'soil_ec_1', 'soil_ec_2', 'soil_ec_3', 'soil_ec_4', 'soil_ec_5', 'soil_ec_6', 'soil_ec_7', 'soil_ec_8',
    ]);
  });

  it('canonicalizes aliases', () => {
    expect(canonicalize('temperature')).toBe('ambient_temperature');
    expect(canonicalize('swt_wm1')).toBe('swt_1');
  });

  it('units come from the manifest', () => {
    expect(channelUnit('swt_1')).toBe('kPa');
    expect(channelUnit('uv_index')).toBeNull();
  });

  it('labels come from the manifest after canonicalization', () => {
    expect(channelLabel('temperature')).toBe('Ambient temperature');
  });

  it('defaults optional manifest fields for registry entries', () => {
    const registry = createChannelRegistry([
      {
        key: 'synthetic_channel',
        unit: 'mm',
        label: 'Synthetic channel',
        cardType: 'environment',
      },
    ]);

    expect(() => registry.canonicalize('synthetic_channel')).not.toThrow();
    expect(registry.cardChannels('environment')).toEqual(['synthetic_channel']);
  });
});
