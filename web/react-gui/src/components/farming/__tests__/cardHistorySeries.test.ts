// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CARD_HISTORY_SERIES_KEYS, isCardHistorySeriesKey } from '../shared/cardHistory';

// The card history modal (SensorMonitor) asks GET /api/devices/:deveui/sensor-history
// for one series key. The edge answers through osi-history-helper.legacySensorHistory,
// which rejects a key it does not know with 400 "Invalid field". This test loads that
// helper from the firmware tree and asks it about every key a card may send, so a
// card can never offer a history button the gateway would refuse.
type HistoryHelper = {
  legacySensorHistory: (db: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
};
const helperPath = decodeURIComponent(new URL(
  '../../../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js',
  import.meta.url,
).pathname);
// The GUI has no Node typings; a non-literal specifier keeps tsc out of node:module.
const nodeModuleSpecifier: string = 'node:module';
const { createRequire } = await import(/* @vite-ignore */ nodeModuleSpecifier);
const historyHelper = createRequire(import.meta.url)(helperPath) as HistoryHelper;

const stubDb = { all: (_sql: string, _params: unknown[], callback: (error: null, rows: unknown[]) => void) => callback(null, []) };

async function routerServes(field: string): Promise<boolean> {
  try {
    // 24 h takes the raw path, which validates the key before it queries.
    await historyHelper.legacySensorHistory(stubDb, { deveui: 'A840410000000001', field, hours: 24, nowMs: Date.parse('2026-10-06T00:00:00Z') });
    return true;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 400) return false;
    throw error;
  }
}

// Keys the changed cards pass as literals (WATERMARK soil temperature, LoRain,
// STREGA enclosure, WATERMARK probes).
const LITERAL_CARD_KEYS = [
  'swt_1', 'swt_2', 'ext_temperature_c', 'ambient_temperature', 'relative_humidity',
  'rain_mm_delta', 'rain_mm_per_10min', 'rain_mm_today',
];

// Keys the SDI-12 card builds as `${kind}_${channel}` for channels 1..10.
const SDI12_KINDS = ['vwc', 'soil_vic', 'soil_temp', 'soil_ec', 'swt'];
const SDI12_KEYS = SDI12_KINDS.flatMap((kind) => Array.from({ length: 10 }, (_, i) => `${kind}_${i + 1}`));

describe('card history series keys', () => {
  it('lists only keys the gateway history route serves', async () => {
    for (const key of CARD_HISTORY_SERIES_KEYS) {
      expect(await routerServes(key), key).toBe(true);
    }
  });

  it('covers every literal key a card passes', () => {
    for (const key of LITERAL_CARD_KEYS) expect(isCardHistorySeriesKey(key), key).toBe(true);
  });

  it('agrees with the gateway for every SDI-12 key, served or not', async () => {
    for (const key of SDI12_KEYS) {
      expect(isCardHistorySeriesKey(key), key).toBe(await routerServes(key));
    }
    // The boundary this guards: soil temperature and EC stop at 8, SWT at 3.
    expect(isCardHistorySeriesKey('soil_temp_9')).toBe(false);
    expect(isCardHistorySeriesKey('soil_ec_10')).toBe(false);
    expect(isCardHistorySeriesKey('swt_4')).toBe(false);
    expect(isCardHistorySeriesKey('vwc_10')).toBe(true);
  });
});
